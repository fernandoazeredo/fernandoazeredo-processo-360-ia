from pathlib import Path
import re

path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')

import_anchor = "import { chargeAnalysis, chargePiece, formatBRL, quoteAnalysis } from './wallet'\n"
if "from 'pdf-lib'" not in text:
    text = text.replace(import_anchor, import_anchor + "import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'\n", 1)

start = text.index('async function exportPieceAsPdf(report: AnalysisReport, piece: LegalPieceDraft) {')
end = text.index('\nfunction exportPieceAsWord(report: AnalysisReport, piece: LegalPieceDraft) {', start)

new_function = r'''async function exportPieceAsPdf(report: AnalysisReport, piece: LegalPieceDraft) {
  if (!(await ensureCurrentProductionBuild())) return

  const fileName = buildPieceFileName(report, piece.pieceType)

  // O PDF protocolável contém somente a peça jurídica. Metadados do Motor B,
  // validação, pontos pendentes e rastreabilidade permanecem exclusivamente na tela.
  const internalSectionPattern = /^(?:pontos?\s+pendentes?|pend[eê]ncias?|rastreabilidade(?:\s+factual)?|valida[cç][aã]o(?:\s+factual)?|auditoria(?:\s+interna)?|relat[oó]rio\s+interno|dados?\s+t[eé]cnicos?)\b/i
  const sections = piece.sections
    .filter(section => {
      const title = String(section.title || '').trim()
      const content = String(section.content || '').trim()
      if (!title && !content) return false
      if (internalSectionPattern.test(title)) return false
      if (internalSectionPattern.test(content.split(/\r?\n/, 1)[0] || '')) return false
      return true
    })

  const pdf = await PDFDocument.create()
  const regularFont = await pdf.embedFont(StandardFonts.TimesRoman)
  const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const pageWidth = 595.28
  const pageHeight = 841.89
  const marginX = 56.7
  const marginTop = 56.7
  const marginBottom = 56.7
  const bodySize = 12
  const headingSize = 12
  const titleSize = 14
  const bodyLineHeight = 18
  const headingLineHeight = 18
  const textWidth = pageWidth - (marginX * 2)
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - marginTop

  const normalizePdfText = (value: string) => String(value || '')
    .replace(/\r/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/•/g, '-')
    .replace(/⚠/g, 'ATENCAO:')
    .replace(/\*\*/g, '')

  const newPage = () => {
    page = pdf.addPage([pageWidth, pageHeight])
    y = pageHeight - marginTop
  }

  const ensureSpace = (height: number) => {
    if (y - height < marginBottom) newPage()
  }

  const wrapLine = (value: string, font: typeof regularFont, size: number) => {
    const clean = normalizePdfText(value).trimEnd()
    if (!clean.trim()) return ['']
    const words = clean.split(/\s+/)
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= textWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current)
      if (font.widthOfTextAtSize(word, size) <= textWidth) {
        current = word
        continue
      }
      let fragment = ''
      for (const char of word) {
        const next = fragment + char
        if (font.widthOfTextAtSize(next, size) <= textWidth) fragment = next
        else {
          if (fragment) lines.push(fragment)
          fragment = char
        }
      }
      current = fragment
    }
    if (current) lines.push(current)
    return lines.length ? lines : ['']
  }

  const drawWrapped = (value: string, font: typeof regularFont, size: number, lineHeight: number, options?: { centered?: boolean }) => {
    const sourceLines = normalizePdfText(value).split('\n')
    for (const sourceLine of sourceLines) {
      const wrapped = wrapLine(sourceLine, font, size)
      for (const line of wrapped) {
        ensureSpace(lineHeight)
        if (line) {
          const width = font.widthOfTextAtSize(line, size)
          const x = options?.centered ? Math.max(marginX, (pageWidth - width) / 2) : marginX
          page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) })
        }
        y -= lineHeight
      }
    }
  }

  // Título da peça, sem prompt, modelo, build ou qualquer outro dado técnico.
  drawWrapped(piece.title, boldFont, titleSize, 20, { centered: true })
  y -= 14

  for (const section of sections) {
    const title = normalizePdfText(section.title).trim()
    const content = normalizePdfText(section.content).trim()

    if (title) {
      ensureSpace(headingLineHeight * 2)
      drawWrapped(title, boldFont, headingSize, headingLineHeight)
      y -= 4
    }

    if (content) {
      const paragraphs = content.split(/\n{2,}/)
      for (const paragraph of paragraphs) {
        drawWrapped(paragraph, regularFont, bodySize, bodyLineHeight)
        y -= 7
      }
    }
    y -= 5
  }

  pdf.setTitle(piece.title)
  pdf.setSubject(piece.pieceType)
  pdf.setCreator('Processo 360 IA')
  pdf.setProducer('Processo 360 IA')

  const bytes = await pdf.save()
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileName}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
'''

text = text[:start] + new_function + text[end:]
path.write_text(text, encoding='utf-8')
