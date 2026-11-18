#!/usr/bin/env python3
"""OCR deterministico senza AI.

Il processo restituisce un documento JSON con una voce per pagina.
PDF e immagini usano dipendenze opzionali; TXT/MD/CSV/HTML e DOCX
funzionano con la libreria standard Python.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def unique_entities(entities: list[dict]) -> list[dict]:
    found: dict[tuple[str, str], dict] = {}
    for entity in entities:
        value = clean_text(str(entity.get("value", "")))
        entity_type = clean_text(str(entity.get("type", "keyword"))).lower() or "keyword"
        if not value:
            continue
        key = (entity_type, value.casefold())
        found.setdefault(key, {"type": entity_type, "value": value, "source": "deterministic-regex"})
    return list(found.values())


def entities_from_text(text: str) -> list[dict]:
    entities: list[dict] = []
    labeled_keywords = re.findall(r"(?:keyword|keywords|parola chiave|tag)\s*[:=\-]\s*([\wÀ-ÿ' .,-]{2,80})", text, re.IGNORECASE)
    for value in labeled_keywords:
        for keyword in re.split(r"[,;]", value):
            entities.append({"type": "keyword", "value": keyword.strip()})
    for value in re.findall(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", text, re.IGNORECASE):
        entities.append({"type": "email", "value": value})
    for value in re.findall(r"\b(?:https?://|www\.)[^\s<>()]+", text, re.IGNORECASE):
        entities.append({"type": "url", "value": value.rstrip('.,;')})
    for value in re.findall(r"\b(?:19|20)\d{2}\b", text):
        entities.append({"type": "year", "value": value})
    for value in re.findall(r"\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)?\d{2}\b", text):
        entities.append({"type": "date", "value": value})
    for value in re.findall(r"\b(?:C\.F\.|P\.IVA|IVA|ID|Protocollo|Prot\.?|Fascicolo)\s*[:#-]?\s*[A-Z0-9][A-Z0-9./_-]{2,}\b", text, re.IGNORECASE):
        entities.append({"type": "identifier", "value": value})
    organization_suffixes = r"S\.p\.A\.|S\.r\.l\.|Srl|SpA|Onlus"
    for value in re.findall(rf"\b(?:[A-ZÀ-Ý][\wÀ-ÿ'’-]+\s+){{1,5}}(?:{organization_suffixes})\b", text):
        entities.append({"type": "organization", "value": value.strip()})
    for value in re.findall(r"\b(?:Ministero|Università|Azienda|Istituto|Fondazione|Associazione)(?:\s+(?:di|del|della|dei|degli|delle))?(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'’-]+){0,4}", text):
        entities.append({"type": "organization", "value": value.strip()})
    location_labels = r"(?:via|viale|piazza|corso|comune di|città di|provincia di|regione|sede di)\s+[A-ZÀ-Ý][\wÀ-ÿ'’-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'’-]+){0,3}"
    for value in re.findall(rf"\b{location_labels}", text, re.IGNORECASE):
        entities.append({"type": "location", "value": value.strip()})
    for value in re.findall(r"\b[A-ZÀ-Ý][a-zà-ÿ'’-]+\s+[A-ZÀ-Ý][a-zà-ÿ'’-]+\b", text):
        if not any(value.casefold() in existing["value"].casefold() for existing in entities if existing["type"] == "organization"):
            entities.append({"type": "person", "value": value})
    return unique_entities(entities)


def text_pages(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() in {".html", ".htm"}:
        raw = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    if path.suffix.lower() == ".docx":
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
        root = ElementTree.fromstring(xml)
        raw = " ".join(node.text or "" for node in root.iter() if node.tag.endswith("}t"))
    return [clean_text(raw)]


def pdf_pages(path: Path) -> list[str]:
    try:
        try:
            import pymupdf as fitz  # PyMuPDF 1.24+
        except ImportError:
            import fitz  # Compatibilità con versioni precedenti
        from PIL import Image
        import pytesseract

        document = fitz.open(path)
        pages = []
        for page in document:
            text = clean_text(page.get_text("text"))
            if not text:
                # PDF scansionato: renderizziamo solo la pagina senza livello testuale
                # e la passiamo a Tesseract. Le pagine native non vengono rasterizzate.
                pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
                image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
                text = clean_text(pytesseract.image_to_string(
                    image,
                    lang="ita+eng",
                    config="--psm 3",
                ))
            pages.append(text)
        return pages
    except ImportError as error:
        raise RuntimeError(
            "Per i PDF installa PyMuPDF, Pillow e pytesseract (`python3 -m pip install -r server/python/requirements.txt`) e Tesseract OCR."
        ) from error



def image_pages(path: Path) -> list[str]:
    try:
        from PIL import Image
        import pytesseract
        return [clean_text(pytesseract.image_to_string(Image.open(path), lang="ita+eng"))]
    except ImportError as error:
        raise RuntimeError("Per le immagini installa Pillow e pytesseract (`pip install pillow pytesseract`) e Tesseract OCR.") from error


def extract_pages(path: Path) -> list[str]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return pdf_pages(path)
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}:
        return image_pages(path)
    if suffix in {".txt", ".md", ".csv", ".html", ".htm", ".docx"}:
        return text_pages(path)
    raise RuntimeError(f"Formato non supportato: {suffix or 'sconosciuto'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--source-key", required=True)
    parser.add_argument("--file-name", required=True)
    args = parser.parse_args()
    path = Path(args.input)
    pages_text = extract_pages(path)
    pages = []
    all_entities = []
    for page_number, text in enumerate(pages_text, start=1):
        page_entities = entities_from_text(text)
        all_entities.extend(page_entities)
        pages.append({"pageNumber": page_number, "text": text, "entities": page_entities, "blocks": []})

    print(json.dumps({
        "schemaVersion": "1.0",
        "sourceKey": args.source_key,
        "fileName": args.file_name,
        "title": Path(args.file_name).stem,
        "extractor": {"name": "rag-deterministic-ocr", "version": "0.1.0", "ai": False},
        "entities": unique_entities(all_entities),
        "pages": pages,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
