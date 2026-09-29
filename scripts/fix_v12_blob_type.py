from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')
old = "const blob = new Blob([bytes], { type: 'application/pdf' })"
new = "const pdfBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer\n  const blob = new Blob([pdfBuffer], { type: 'application/pdf' })"
if old not in text:
    raise SystemExit('Linha do Blob v12 não encontrada')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
