from pathlib import Path

p = Path('src/gemini.ts')
text = p.read_text(encoding='utf-8')
text = text.replace('GEMINI_REQUEST_TIMEOUT: o Gemini não respondeu dentro de 90 segundos. A análise foi interrompida sem perder os lotes já concluídos.', 'GEMINI_REQUEST_TIMEOUT: o Gemini não respondeu dentro de 210 segundos. A análise foi interrompida sem perder os lotes já concluídos.')
text = text.replace(r"R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\b\d+(?:[.,]\d+)?\s*%", r"R\$\s*\d+(?:\.\d{3})*(?:,\d{2})?|\b\d+(?:[.,]\d+)?\s*%")
p.write_text(text, encoding='utf-8')

Path('scripts/finalize_v8.py').unlink(missing_ok=True)
Path('.github/workflows/finalize-v8.yml').unlink(missing_ok=True)
