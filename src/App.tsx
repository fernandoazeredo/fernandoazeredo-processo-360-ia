import { FormEvent, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from 'firebase/auth'
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronRight, Download, FilePenLine, FileText, LockKeyhole, Moon, Pencil, Plus, Save, Search, ShieldCheck, Sun, Trash2, UploadCloud, X } from 'lucide-react'
import { auth, db, firebaseConfigured } from './firebase'
import { analyzeUploadedProcess } from './ai'
import type { AnalysisReport } from './ai'
import { confirmClaimInOriginal, generateLegalPiece, pieceTypeOptions, suggestPieceType } from './pieces'
import type { LegalPieceDraft, PieceClaim } from './pieces'

const ADMIN_EMAIL = 'fernandoazeredo64@gmail.com'

type Area = 'Trabalhista' | 'Cível' | 'Criminal' | 'Ambiental' | 'Tributário' | 'Administrativo' | 'Previdenciário' | 'Consumidor' | 'Família' | 'Empresarial'
type PromptStatus = 'rascunho' | 'publicado' | 'inativo'

type PromptItem = {
  id: string
  title: string
  area: Area
  perspective: string
  purpose: string
  content: string
  version: number
  status: PromptStatus
}

const perspectives: Record<Area, string[]> = {
  Trabalhista: ['Reclamante', 'Reclamada'],
  Cível: ['Autor', 'Réu'],
  Criminal: ['Defesa', 'Acusação', 'Assistente de acusação', 'Querelante'],
  Ambiental: ['Autuado / Réu', 'Órgão Ambiental / MP'],
  Tributário: ['Contribuinte', 'Fazenda Pública'],
  Administrativo: ['Administrado', 'Administração Pública'],
  Previdenciário: ['Segurado', 'INSS'],
  Consumidor: ['Consumidor', 'Fornecedor / Empresa'],
  Família: ['Requerente', 'Requerido'],
  Empresarial: ['Parte Autora', 'Parte Ré']
}

const promptPurposes = [
  'Preparação e leitura inicial',
  'Extração por lote',
  'Catalogação documental',
  'Linha do tempo processual',
  'Confronto de alegações e provas',
  'Análise jurídica global',
  'Cenário percentual de risco',
  'Relatório final'
]

const stages = [
  'Preparando o processo',
  'Lendo o PDF localmente',
  'Dividindo o PDF em lotes seguros no navegador',
  'Extraindo e catalogando os documentos com Gemini',
  'Salvando lotes concluídos para retomada',
  'Confrontando alegações, provas e decisões',
  'Elaborando a análise jurídica global',
  'Preparando o relatório final'
]


function InlineMarkdown({text}:{text:string}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((part,index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2,-2)}</strong>
      : <span key={index}>{part}</span>
  )}</>
}

function MarkdownBlock({text}:{text:string}) {
  const normalized = String(text || '')
    .replace(/\r/g,'')
    .replace(/\|\s+\|/g, '|\n|')
  const lines = normalized.split('\n')
  const blocks: JSX.Element[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trim()

    if (!line) {
      i++
      continue
    }

    const next = (lines[i + 1] || '').trim()
    const isTableHeader = line.startsWith('|') && line.endsWith('|')
      && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next)

    if (isTableHeader) {
      const parseRow = (row:string) => row.trim().replace(/^\||\|$/g,'').split('|').map(cell => cell.trim())
      const headers = parseRow(line)
      const rows:string[][] = []
      i += 2
      while (i < lines.length) {
        const row = lines[i].trim()
        if (!(row.startsWith('|') && row.endsWith('|'))) break
        rows.push(parseRow(row))
        i++
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${i}`}>
          <table className="markdown-table">
            <thead><tr>{headers.map((cell,index)=><th key={index}><InlineMarkdown text={cell}/></th>)}</tr></thead>
            <tbody>{rows.map((row,rowIndex)=><tr key={rowIndex}>{headers.map((_,cellIndex)=><td key={cellIndex}><InlineMarkdown text={row[cellIndex] || ''}/></td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items:string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/,''))
        i++
      }
      blocks.push(<ul className="markdown-list" key={`ul-${i}`}>{items.map((item,index)=><li key={index}><InlineMarkdown text={item}/></li>)}</ul>)
      continue
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items:string[] = []
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/,''))
        i++
      }
      blocks.push(<ol className="markdown-list" key={`ol-${i}`}>{items.map((item,index)=><li key={index}><InlineMarkdown text={item}/></li>)}</ol>)
      continue
    }

    if (/^#{1,4}\s+/.test(line)) {
      const title = line.replace(/^#{1,4}\s+/,'')
      blocks.push(<h4 className="markdown-heading" key={`h-${i}`}><InlineMarkdown text={title}/></h4>)
      i++
      continue
    }

    const paragraph:string[] = [line]
    i++
    while (i < lines.length) {
      const candidate = lines[i].trim()
      const following = (lines[i + 1] || '').trim()
      if (!candidate) break
      if (/^[-*]\s+/.test(candidate) || /^\d+[.)]\s+/.test(candidate) || /^#{1,4}\s+/.test(candidate)) break
      if (candidate.startsWith('|') && candidate.endsWith('|')
        && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(following)) break
      paragraph.push(candidate)
      i++
    }
    blocks.push(<p className="markdown-paragraph" key={`p-${i}`}><InlineMarkdown text={paragraph.join(' ')} /></p>)
  }

  return <div className="markdown-content">{blocks}</div>
}

function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('p360-theme') !== 'light')
  const [file, setFile] = useState<File | null>(null)
  const [area, setArea] = useState<Area>('Trabalhista')
  const [perspective, setPerspective] = useState('Reclamada')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [processingStage, setProcessingStage] = useState(stages[0])
  const [analysis, setAnalysis] = useState<AnalysisReport | null>(null)
  const [analysisError, setAnalysisError] = useState('')
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminUser, setAdminUser] = useState<User | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('p360-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, user => setAdminUser(user?.email === ADMIN_EMAIL ? user : null))
  }, [])

  function changeArea(next: Area) {
    setArea(next)
    setPerspective(perspectives[next][0])
  }

  async function startAnalysis() {
    if (!file) return
    setAnalysisError('')
    setAnalysis(null)

    setProgress(0)
    setProcessingStage(stages[0])
    setProcessing(true)

    try {
      const report = await analyzeUploadedProcess(file, area, perspective, (value, stage) => {
        setProgress(value)
        setProcessingStage(stage)
      })
      setAnalysis(report)
      window.setTimeout(() => {
        document.getElementById('analysis-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 150)
    } catch (error: any) {
      const message = String(error?.message || '')
      console.error('[Processo 360 IA] Falha na análise', error)
      if (message.includes('ANALYSIS_CANCELLED')) {
        setAnalysisError('')
      } else if (message.includes('GEMINI_BILLING_STATE_MISMATCH')) {
        setAnalysisError('O Google retornou um estado de faturamento inconsistente para o projeto. Verifique o faturamento do Firebase/Google Cloud e tente novamente.')
      } else if (message.includes('GEMINI_RATE_LIMIT')) {
        setAnalysisError('O Gemini atingiu temporariamente um limite de requisições ou cota do serviço. Aguarde alguns instantes e tente novamente: os lotes já concluídos ficaram salvos para retomada automática.')
      } else if (message.includes('GEMINI_TEMPORARILY_BUSY')) {
        setAnalysisError('O Gemini está temporariamente com alta demanda. Foram feitas tentativas com os modelos de fallback configurados. Tente novamente; os lotes concluídos ficaram salvos para retomada.')
      } else if (message.includes('GEMINI_REQUEST_TIMEOUT')) {
        setAnalysisError('O Gemini não respondeu dentro do limite de 90 segundos por tentativa. Tente novamente; os lotes já concluídos foram preservados.')
      } else if (message.includes('GEMINI_MODEL_UNAVAILABLE')) {
        setAnalysisError('Nenhum dos modelos Gemini configurados respondeu corretamente nesta tentativa. Tente novamente mais tarde.')
      } else if (message.includes('GEMINI_APP_CHECK_INVALID')) {
        setAnalysisError('O Firebase App Check rejeitou a chamada ao Gemini. Recarregue a página e tente novamente.')
      } else if (message.includes('FIREBASE_AI_NOT_READY')) {
        setAnalysisError('O Firebase AI Logic ainda não está configurado corretamente para o aplicativo.')
      } else {
        setAnalysisError('Não foi possível concluir a análise. ' + (message || 'Verifique a configuração do Gemini e tente novamente.'))
      }
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="logo-light" src="/assets/logo-processo-360-ia.svg" alt="Processo 360 IA" />
          <img className="logo-dark" src="/assets/logo-processo-360-ia-dark.svg" alt="Processo 360 IA" />
        </div>
        <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Alternar tema">
          {dark ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </header>

      <main>
        <section className="hero">
          <span className="eyebrow"><BrainCircuit size={16} /> Inteligência jurídica especializada</span>
          <h1>O processo completo.<br /><em>Analisado por inteiro.</em></h1>
          <p>Envie o PDF, selecione a área e a perspectiva, e receba uma análise jurídica estruturada, rastreável e completa do processo.</p>
        </section>

        <section className="workspace-card">
          <div className="step-heading"><span>1</span><div><b>Envie o processo</b><small>Arquivo único em PDF. A divisão em lotes será automática.</small></div></div>
          <label className={`dropzone ${file ? 'has-file' : ''}`}>
            <input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            {file
              ? <><FileText size={34}/><b>{file.name}</b><small>{(file.size / 1024 / 1024).toFixed(2)} MB · PDF selecionado</small></>
              : <><UploadCloud size={38}/><b>Arraste o processo ou selecione o PDF</b><small>O sistema dividirá automaticamente o PDF em lotes seguros, por páginas e tamanho, e, ao final, entregará uma única análise consolidada, com conclusão.</small></>}
          </label>

          <div className="step-heading second"><span>2</span><div><b>Escolha a área e a perspectiva</b></div></div>
          <div className="form-grid">
            <label>Área do Direito
              <select value={area} onChange={e => changeArea(e.target.value as Area)}>
                {Object.keys(perspectives).map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>Perspectiva
              <select value={perspective} onChange={e => setPerspective(e.target.value)}>
                {perspectives[area].map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>

          <button className="primary-button" disabled={!file || processing} onClick={startAnalysis}>
            {processing ? 'Analisando processo...' : 'Iniciar análise completa'} <ChevronRight size={18}/>
          </button>
          {analysisError && (
            <div className="analysis-error-actions">
              <p className="analysis-error">{analysisError}</p>
              <button type="button" className="retry-analysis-button" disabled={!file || processing} onClick={startAnalysis}>
                Tentar novamente
              </button>
            </div>
          )}
        </section>

        {analysis && <AnalysisResult report={analysis} originalFile={file} />}

        <section className="trust-row">
          <span><ShieldCheck/> Rastreabilidade documental</span>
          <span><LockKeyhole/> Prompts protegidos</span>
          <span><BrainCircuit/> Diagnóstico somente após leitura integral</span>
        </section>
      </main>

      <footer><span>© 2026 Processo 360 IA</span><button onClick={() => setAdminOpen(true)}>Área ADM</button></footer>

      {processing && <div className="processing-overlay" role="dialog" aria-modal="true" aria-label="Análise em andamento">
        <div className="processing-inner">
          <BrainLoader />
          <div className="live-progress">
            <strong>{progress}%</strong>
            <div className="progress-track"><i style={{width:`${progress}%`}} /></div>
            <span>{processingStage}...</span>
            <small>Processos extensos podem levar vários minutos. Não feche esta janela.</small>
          </div>
        </div>
      </div>}

      {adminOpen && <AdminModal user={adminUser} onUser={setAdminUser} onClose={() => setAdminOpen(false)} />}
    </div>
  )
}

function buildExportFileName(report: AnalysisReport) {
  const fallback = `processo-${report.analysisId.slice(0, 8)}`
  const rawProcessNumber = report.processNumber?.trim()
  const hasProcessNumber = Boolean(
    rawProcessNumber &&
    rawProcessNumber !== 'Informação não constante nos dados fornecidos'
  )
  const processLabel = (hasProcessNumber ? rawProcessNumber! : fallback)
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()

  const lotNumbers = Array.from(new Set(report.sources.map(s => s.lot))).sort((a, b) => a - b)
  const loteLabel = lotNumbers.length <= 1
    ? 'lote único'
    : lotNumbers.map(n => `lote ${n}`).join(', ')

  return `${processLabel} - ${loteLabel}`
}

async function exportAnalysisAsPdf(report: AnalysisReport) {
  const root = document.documentElement
  const previousTitle = document.title
  const previousTheme = root.dataset.theme

  document.title = buildExportFileName(report)
  root.dataset.theme = 'light'
  root.classList.add('pdf-exporting')

  const restoreExportState = () => {
    document.title = previousTitle
    if (previousTheme) root.dataset.theme = previousTheme
    else delete root.dataset.theme
    root.classList.remove('pdf-exporting')
    window.removeEventListener('afterprint', restoreExportState)
  }

  window.addEventListener('afterprint', restoreExportState)

  try {
    if (document.fonts?.ready) await document.fonts.ready
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    window.print()
  } catch (error) {
    restoreExportState()
    throw error
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function buildPieceFileName(report: AnalysisReport, pieceType: string) {
  const process = report.processNumber && report.processNumber !== 'Informação não constante nos dados fornecidos'
    ? report.processNumber
    : `processo-${report.analysisId.slice(0, 8)}`
  return `${process} - ${pieceType}`.replace(/[\\/:*?"<>|]/g, '-').trim()
}

async function exportPieceAsPdf(report: AnalysisReport, piece: LegalPieceDraft) {
  const fileName = buildPieceFileName(report, piece.pieceType)
  const banner = 'RASCUNHO DE PEÇA PROCESSUAL — Revisão jurídica por advogado é obrigatória antes de qualquer protocolo ou utilização processual.'

  const sectionsHtml = piece.sections
    .filter(section => section.title.trim() || section.content.trim())
    .map(section => {
      const body = escapeHtml(section.content)
        .replace(/\r?\n\r?\n/g, '</p><p>')
        .replace(/\r?\n/g, '<br>')
      return `<section class="doc-section"><h2>${escapeHtml(section.title)}</h2><div class="doc-body"><p>${body}</p></div></section>`
    })
    .join('')

  const traceabilityHtml = piece.claims.length
    ? `<section class="traceability"><h2>Rastreabilidade factual</h2>${piece.claims.map(claim => `
        <div class="trace-row">
          <p><strong>${escapeHtml(claim.status)}</strong> — ${escapeHtml(claim.text)}</p>
          <p><b>Origem:</b> ${escapeHtml(claim.sourceReference || 'Sem referência específica')}</p>
          ${claim.treatment ? `<p><b>Tratamento:</b> ${escapeHtml(claim.treatment)}</p>` : ''}
        </div>`).join('')}</section>`
    : ''

  const printHtml = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(fileName)}</title>
<style>
  @page { size: A4; margin: 18mm 17mm 18mm 17mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff !important;
    color: #111 !important;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
  }
  body::before, body::after, *::before, *::after {
    content: none !important;
    display: none !important;
  }
  .warning {
    margin: 0 0 14pt;
    padding: 0 0 8pt;
    border: 0;
    border-bottom: 1px solid #bdbdbd;
    background: #fff !important;
    color: #111 !important;
    font-size: 9.5pt;
    font-weight: 700;
  }
  h1 {
    margin: 0 0 5pt;
    padding: 0;
    text-align: center;
    color: #111 !important;
    background: #fff !important;
    font-size: 14pt;
    line-height: 1.3;
  }
  .meta {
    margin: 0 0 18pt;
    text-align: center;
    color: #444 !important;
    background: #fff !important;
    font-size: 9pt;
  }
  .doc-section {
    margin: 0 0 14pt;
    padding: 0;
    border: 0;
    background: #fff !important;
    box-shadow: none !important;
    filter: none !important;
  }
  .doc-section h2,
  .traceability h2 {
    margin: 0 0 7pt;
    padding: 0 0 4pt;
    border: 0;
    border-bottom: 1px solid #cfcfcf;
    background: #fff !important;
    color: #111 !important;
    font-size: 11.5pt;
    break-after: avoid-page;
  }
  .doc-body, .doc-body *, .doc-body p {
    margin-top: 0;
    background: #fff !important;
    background-image: none !important;
    color: #111 !important;
    border: 0 !important;
    border-left: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    text-shadow: none !important;
    filter: none !important;
    outline: 0 !important;
    -webkit-text-fill-color: #111 !important;
  }
  .doc-body p {
    margin: 0 0 7pt;
    padding: 0;
    orphans: 3;
    widows: 3;
  }
  .traceability {
    margin: 20pt 0 0;
    padding: 0;
    border: 0;
    background: #fff !important;
  }
  .trace-row {
    margin: 0 0 9pt;
    padding: 0 0 7pt;
    border: 0;
    border-bottom: 1px solid #e2e2e2;
    background: #fff !important;
    break-inside: avoid;
  }
  .trace-row p, .trace-row strong, .trace-row b {
    margin: 0 0 3pt;
    padding: 0;
    background: #fff !important;
    color: #111 !important;
    border: 0 !important;
    box-shadow: none !important;
    text-shadow: none !important;
    -webkit-text-fill-color: #111 !important;
  }
</style>
</head>
<body>
  <div class="warning">${escapeHtml(banner)}</div>
  <h1>${escapeHtml(piece.title)}</h1>
  <div class="meta">Tipo: ${escapeHtml(piece.pieceType)} · Prompt: ${escapeHtml(piece.promptVersion)} · Modelo: ${escapeHtml(piece.model)}</div>
  ${sectionsHtml}
  ${traceabilityHtml}
<script>
  window.addEventListener('load', () => {
    setTimeout(() => {
      window.focus();
      window.print();
    }, 80);
  });
  window.addEventListener('afterprint', () => window.close());
<\/script>
</body>
</html>`

  const printWindow = window.open('', '_blank', 'width=900,height=800')
  if (!printWindow) {
    throw new Error('Não foi possível abrir a janela de impressão. Verifique o bloqueio de pop-ups do navegador.')
  }

  printWindow.document.open()
  printWindow.document.write(printHtml)
  printWindow.document.close()
}

function exportPieceAsWord(report: AnalysisReport, piece: LegalPieceDraft) {
  const banner = 'RASCUNHO DE PEÇA PROCESSUAL — Revisão jurídica por advogado é obrigatória antes de qualquer protocolo ou utilização processual.'
  const sections = piece.sections
    .filter(section => section.title.trim() || section.content.trim())
    .map(section => `<section><h2>${escapeHtml(section.title)}</h2><div>${escapeHtml(section.content).replace(/\n/g, '<br>')}</div></section>`)
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.5;color:#111;margin:2.5cm}
    h1{text-align:center;font-size:14pt;margin:0 0 20pt}
    h2{font-size:12pt;margin:18pt 0 8pt;border-bottom:1px solid #bbb;padding-bottom:4pt}
    .warning{font-size:10pt;border:1px solid #bbb;padding:8pt;margin-bottom:18pt}
    section{margin-bottom:12pt}
  </style></head><body><div class="warning">${escapeHtml(banner)}</div><h1>${escapeHtml(piece.title)}</h1>${sections}</body></html>`

  const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${buildPieceFileName(report, piece.pieceType)}.doc`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function AnalysisResult({report, originalFile}:{report:AnalysisReport;originalFile:File|null}) {
  const [pieceOpen, setPieceOpen] = useState(false)
  const [pieceType, setPieceType] = useState(() => suggestPieceType(report.area, report.perspective))
  const [piece, setPiece] = useState<LegalPieceDraft | null>(null)
  const [pieceBusy, setPieceBusy] = useState(false)
  const [pieceStage, setPieceStage] = useState('')
  const [pieceError, setPieceError] = useState('')
  const [confirmingClaim, setConfirmingClaim] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Record<string, string>>({})

  const options = pieceTypeOptions(report.area, report.perspective)

  async function handleGeneratePiece() {
    setPieceError('')
    setPiece(null)
    setPieceBusy(true)
    setPieceStage('Estruturando e redigindo o rascunho')
    try {
      window.setTimeout(() => setPieceStage('Validando fatos contra o relatório consolidado'), 900)
      const generated = await generateLegalPiece(report, pieceType)
      setPiece(generated)
      setPieceStage('Rascunho validado')
      window.setTimeout(() => document.getElementById('piece-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    } catch (error: any) {
      console.error('[Processo 360 IA][Motor B] Falha', error)
      setPieceError('Não foi possível gerar e validar o rascunho. ' + String(error?.message || 'Tente novamente.'))
    } finally {
      setPieceBusy(false)
    }
  }

  function updatePieceSection(index: number, value: string) {
    setPiece(current => current ? {
      ...current,
      sections: current.sections.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, content: value } : section
      )
    } : current)
  }

  async function handleConfirmClaim(claim: PieceClaim) {
    if (!originalFile) {
      setConfirmation(current => ({ ...current, [claim.id]: 'O PDF original não está mais disponível nesta sessão.' }))
      return
    }
    setConfirmingClaim(claim.id)
    try {
      const result = await confirmClaimInOriginal(originalFile, claim)
      setConfirmation(current => ({
        ...current,
        [claim.id]: `${result.status} — páginas ${result.pages}: ${result.evidence}${result.note ? ` — ${result.note}` : ''}`
      }))
    } catch (error: any) {
      const message = String(error?.message || '')
      const friendly = message.includes('PIECE_TARGETED_SOURCE_NOT_AVAILABLE')
        ? 'A confirmação pontual exige referência de página no relatório. O sistema não fará nova leitura integral do PDF.'
        : 'Não foi possível confirmar este fato no trecho original.'
      setConfirmation(current => ({ ...current, [claim.id]: friendly }))
    } finally {
      setConfirmingClaim(null)
    }
  }

  return <section className="analysis-result" id="analysis-result">
    <div className="analysis-toolbar no-print">
      <div>
        <span className="eyebrow"><FileText size={16}/> Resultado da análise</span>
        <h2>Relatório jurídico consolidado</h2>
      </div>
      <div className="analysis-toolbar-actions">
        <button className="piece-launch-button" onClick={() => setPieceOpen(true)}><FilePenLine size={18}/> Gerar Peça Jurídica</button>
        <button className="export-button" onClick={() => exportAnalysisAsPdf(report)}><Download size={18}/> Exportar análise em PDF</button>
      </div>
    </div>

    <div className="analysis-meta">
      <span><b>Arquivo:</b> {report.fileName}</span>
      <span><b>Área:</b> {report.area}</span>
      <span><b>Perspectiva:</b> {report.perspective}</span>
      <span><b>Nº do processo:</b> {report.processNumber}</span>
      <span><b>ID:</b> {report.analysisId}</span>
    </div>
    {report.processNumberWarning && (
      <div className="analysis-warning">
        <b>Divergência detectada:</b> {report.processNumberWarning}
      </div>
    )}

    <div className="analysis-section-full">
      <h3>1. Resumo executivo</h3>
      <MarkdownBlock text={report.executiveSummary}/>
    </div>

    <div className="analysis-section-full">
      <h3>2. Linha do tempo processual</h3>
      {report.timeline.length
        ? <div className="timeline-list">{report.timeline.map((item,i)=>
            <div className="timeline-item" key={i}>
              <strong>{item.date || 'Data não identificada'}</strong>
              <span>{item.event}</span>
              <small>{item.reference}</small>
            </div>)}</div>
        : <p>Nenhum evento cronológico estruturado foi retornado.</p>}
    </div>

    <div className="analysis-grid">
      <article><h3>3. Alegações, provas e decisões</h3><MarkdownBlock text={report.claimsEvidenceDecisions}/></article>
      <article><h3>4. Análise jurídica global</h3><MarkdownBlock text={report.globalAnalysis}/></article>
    </div>

    <div className="analysis-section-full">
      <h3>5. Riscos e pontos de atenção</h3>
      {report.risks.length
        ? <div className="risk-list">{report.risks.map((risk,i)=>
            <div className="risk-item" key={i}>
              <div><strong>{risk.item}</strong><span className="risk-level">{risk.level}</span></div>
              <p>{risk.basis}</p>
            </div>)}</div>
        : <p>Nenhum risco estruturado foi retornado.</p>}
    </div>

    <div className="analysis-section-full">
      <h3>6. Conclusão e estratégia</h3>
      <MarkdownBlock text={report.conclusionStrategy}/>
    </div>

    <div className="analysis-section-full sources-block">
      <h3>7. Rastreabilidade dos lotes</h3>
      <div className="source-list">
        {report.sources.map((source,i)=>
          <div key={i}><b>Lote {source.lot}</b><span>Páginas {source.pages}</span><small>{source.note}</small></div>)}
      </div>
    </div>

    {pieceOpen && <section className="piece-module" id="piece-module">
      <div className="piece-controls no-print" data-ui-only="true">
        <div>
          <span className="eyebrow"><FilePenLine size={16}/> Módulo opcional</span>
          <h2>Gerar Peça Jurídica</h2>
          <p>O Motor B usa somente o relatório consolidado. O PDF original não será reprocessado.</p>
        </div>
        <div className="piece-context">
          <span><b>Área:</b> {report.area}</span>
          <span><b>Perspectiva:</b> {report.perspective}</span>
        </div>
        <label>Tipo de peça
          <select value={pieceType} onChange={event => setPieceType(event.target.value)}>
            {options.map(option => <option key={option}>{option}</option>)}
          </select>
        </label>
        <button className="primary-button" disabled={pieceBusy} onClick={handleGeneratePiece}>
          {pieceBusy ? pieceStage || 'Gerando rascunho...' : 'Gerar Rascunho'} <ChevronRight size={18}/>
        </button>
        {pieceError && <p className="analysis-error">{pieceError}</p>}
      </div>

      {piece && <div className="piece-review" id="piece-review">
        <div className="piece-draft-banner">
          <AlertTriangle size={20}/>
          <strong>RASCUNHO DE PEÇA PROCESSUAL — Revisão jurídica por advogado é obrigatória antes de qualquer protocolo ou utilização processual.</strong>
        </div>

        <div className="piece-review-heading">
          <div>
            <span className="eyebrow">Minuta validada</span>
            <h2>{piece.title}</h2>
            <small>Tipo: {piece.pieceType} · Prompt: {piece.promptVersion} · Modelo: {piece.model}</small>
          </div>
          <div className="piece-actions no-print" data-ui-only="true">
            <button onClick={() => exportPieceAsWord(report, piece)}><Download size={17}/> Exportar Word</button>
            <button onClick={() => exportPieceAsPdf(report, piece)}><Download size={17}/> Exportar PDF</button>
          </div>
        </div>

        <div className="piece-validation-panel no-print" data-ui-only="true">
          <h3>Validação factual automática</h3>
          <div className="validation-counts">
            <span><CheckCircle2 size={16}/> {piece.validation.confirmed} confirmadas</span>
            <span>{piece.validation.partiallyConfirmed} parcialmente confirmadas</span>
            <span>{piece.validation.unconfirmed} não confirmadas</span>
            <span>{piece.validation.conflicting} conflitantes</span>
          </div>
          {(piece.validation.unconfirmed > 0 || piece.validation.conflicting > 0) &&
            <p>Nenhum item não confirmado ou conflitante permanece silenciosamente como fato certo: o texto foi removido, reformulado ou marcado para confirmação.</p>}
        </div>

        <div className="piece-document">
          {piece.sections.filter(section => section.title.trim() || section.content.trim()).map((section,index) =>
            <section className="piece-section" key={`${section.title}-${index}`}>
              <h3>{section.title}</h3>
              <textarea
                className="piece-editor no-print"
                value={section.content}
                onChange={event => updatePieceSection(index, event.target.value)}
                rows={Math.max(5, Math.min(18, section.content.split('\n').length + 3))}
              />
              <div className="piece-content print-only"><MarkdownBlock text={section.content}/></div>
            </section>)}
        </div>

        {piece.claims.length > 0 && <>
          <div className="piece-claims no-print" data-ui-only="true">
            <h3>Rastreabilidade factual</h3>
            {piece.claims.map(claim =>
              <article className={`piece-claim status-${claim.status.toLowerCase().replace(/\s+/g,'-')}`} key={claim.id}>
                <div className="piece-claim-top">
                  <strong>{claim.status}</strong>
                  <span>{claim.type}</span>
                </div>
                <p>{claim.text}</p>
                <small><b>Origem:</b> {claim.sourceReference || 'Sem referência específica'}</small>
                {claim.treatment && <small><b>Tratamento:</b> {claim.treatment}</small>}
                <button onClick={() => handleConfirmClaim(claim)} disabled={confirmingClaim === claim.id}>
                  <Search size={15}/> {confirmingClaim === claim.id ? 'Confirmando...' : 'Confirmar este fato no documento original'}
                </button>
                {confirmation[claim.id] && <div className="piece-confirm-result">{confirmation[claim.id]}</div>}
              </article>)}
          </div>

          <section className="piece-traceability-print print-only" aria-label="Rastreabilidade factual">
            <h3>Rastreabilidade factual</h3>
            {piece.claims.map(claim =>
              <div className="piece-trace-row" key={`print-${claim.id}`}>
                <p><strong>{claim.status}</strong> — {claim.text}</p>
                <p><b>Origem:</b> {claim.sourceReference || 'Sem referência específica'}</p>
                {claim.treatment && <p><b>Tratamento:</b> {claim.treatment}</p>}
              </div>)}
          </section>
        </>}
      </div>}
    </section>}
  </section>
}

function BrainLoader() {
  const nodes = [[50,18],[35,27],[65,27],[26,41],[50,38],[74,41],[22,58],[39,55],[61,55],[78,58],[31,72],[50,69],[69,72],[41,84],[59,84]]

  return <div className="brain-loader brain-loader-blue" aria-hidden="true">
    <img className="ai-brain-image" src="/assets/brain-ai-blue.webp?v=7" alt="" />
    <svg className="brain-circuit-overlay" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="blueCircuitGlow">
          <feGaussianBlur stdDeviation="1.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g className="circuits blue-circuits" filter="url(#blueCircuitGlow)">
        <path d="M49 20 38 27 28 41 39 55 31 72 41 84M51 20 62 27 72 41 61 55 69 72 59 84M49 38H35L22 58l17-3 10 14M51 38h14l13 20-17-3-10 14"/>
        {nodes.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="1.6" style={{animationDelay:`-${i*.17}s`}}/>)}
      </g>
    </svg>
  </div>
}

function AdminModal({user,onUser,onClose}:{user:User|null;onUser:(u:User|null)=>void;onClose:()=>void}) {
  const [password,setPassword]=useState('')
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)

  async function login(e:FormEvent) {
    e.preventDefault()
    setError('')
    if (!auth) {
      setError('Configure as credenciais do Firebase para ativar o login.')
      return
    }
    setLoading(true)
    try {
      const credential=await signInWithEmailAndPassword(auth,ADMIN_EMAIL,password)
      if (credential.user.email !== ADMIN_EMAIL) {
        await signOut(auth)
        throw new Error('unauthorized')
      }
      onUser(credential.user)
    } catch {
      setError('E-mail ou senha inválidos, ou acesso não autorizado.')
    } finally {
      setLoading(false)
    }
  }

  async function logout(){
    if(auth) await signOut(auth)
    onUser(null)
  }

  return <div className="modal-backdrop">
    <div className={`admin-modal ${user ? 'admin-modal-large' : ''}`}>
      <button className="modal-close" onClick={onClose} aria-label="Fechar"><X/></button>
      {user
        ? <PromptManager user={user} onLogout={logout}/>
        : <form onSubmit={login}>
            <span className="admin-badge"><LockKeyhole/> Acesso restrito</span>
            <h2>Área ADM</h2>
            <p className="muted">Gerenciamento dos prompts jurídicos do Processo 360 IA.</p>
            <label>E-mail<input value={ADMIN_EMAIL} readOnly /></label>
            <label>Senha<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoFocus /></label>
            {error&&<p className="error">{error}</p>}
            <button className="primary-button" disabled={loading}>{loading?'Entrando...':'Entrar'}</button>
            {!firebaseConfigured&&<small className="config-note">Login aguardando configuração do Firebase Authentication.</small>}
          </form>}
    </div>
  </div>
}

function PromptManager({user,onLogout}:{user:User;onLogout:()=>void}) {
  const [items,setItems]=useState<PromptItem[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [editingId,setEditingId]=useState<string|null>(null)
  const [title,setTitle]=useState('')
  const [area,setArea]=useState<Area>('Trabalhista')
  const [perspective,setPerspective]=useState('Reclamada')
  const [purpose,setPurpose]=useState(promptPurposes[0])
  const [content,setContent]=useState('')
  const [version,setVersion]=useState(1)
  const [status,setStatus]=useState<PromptStatus>('rascunho')

  useEffect(()=>{
    if(!db){
      setLoading(false)
      setError('Firestore não configurado.')
      return
    }
    const q=query(collection(db,'prompts'),orderBy('updatedAt','desc'))
    return onSnapshot(q,snap=>{
      setItems(snap.docs.map(d=>({id:d.id,...d.data()} as PromptItem)))
      setLoading(false)
    },()=>{
      setLoading(false)
      setError('Não foi possível carregar os prompts. Verifique as regras do Firestore.')
    })
  },[])

  function changeArea(next:Area){
    setArea(next)
    setPerspective(perspectives[next][0])
  }

  function reset(){
    setEditingId(null)
    setTitle('')
    setArea('Trabalhista')
    setPerspective('Reclamada')
    setPurpose(promptPurposes[0])
    setContent('')
    setVersion(1)
    setStatus('rascunho')
  }

  function edit(item:PromptItem){
    setEditingId(item.id)
    setTitle(item.title)
    setArea(item.area)
    setPerspective(item.perspective)
    setPurpose(item.purpose)
    setContent(item.content)
    setVersion(item.version || 1)
    setStatus(item.status || 'rascunho')
  }

  async function save(e:FormEvent){
    e.preventDefault()
    setError('')
    if(!db) return

    const payload={
      title:title.trim(),
      area,
      perspective,
      purpose,
      content:content.trim(),
      version:Number(version)||1,
      status,
      updatedAt:serverTimestamp(),
      updatedBy:user.email
    }

    try{
      if(editingId) await updateDoc(doc(db,'prompts',editingId),payload)
      else await addDoc(collection(db,'prompts'),{...payload,createdAt:serverTimestamp(),createdBy:user.email})
      reset()
    }catch{
      setError('Não foi possível salvar. Confirme se o Firestore está criado e com as regras publicadas.')
    }
  }

  async function remove(id:string){
    if(!db || !window.confirm('Excluir este prompt?')) return
    try{
      await deleteDoc(doc(db,'prompts',id))
      if(editingId===id) reset()
    }catch{
      setError('Não foi possível excluir o prompt.')
    }
  }

  return <>
    <div className="admin-header">
      <div>
        <span className="admin-badge"><ShieldCheck/> Administração</span>
        <h2>Painel de prompts</h2>
        <p className="muted">Cadastre o comando usado em cada etapa, área e perspectiva da análise.</p>
      </div>
      <button className="secondary-button compact" onClick={onLogout}>Sair</button>
    </div>

    <div className="admin-layout">
      <form className="prompt-form" onSubmit={save}>
        <div className="form-title"><Plus size={18}/><b>{editingId?'Editar prompt':'Novo prompt'}</b></div>

        <label>Título
          <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ex.: Análise global - defesa da reclamada" required />
        </label>

        <div className="admin-form-grid">
          <label>Área
            <select value={area} onChange={e=>changeArea(e.target.value as Area)}>
              {Object.keys(perspectives).map(a=><option key={a}>{a}</option>)}
            </select>
          </label>
          <label>Perspectiva
            <select value={perspective} onChange={e=>setPerspective(e.target.value)}>
              {perspectives[area].map(p=><option key={p}>{p}</option>)}
            </select>
          </label>
        </div>

        <label>Finalidade
          <select value={purpose} onChange={e=>setPurpose(e.target.value)}>
            {promptPurposes.map(p=><option key={p}>{p}</option>)}
          </select>
        </label>

        <label>Texto do prompt
          <textarea value={content} onChange={e=>setContent(e.target.value)} rows={12} placeholder="Cole aqui o prompt completo que a IA deverá usar nesta etapa..." required />
        </label>

        <div className="admin-form-grid">
          <label>Versão<input type="number" min="1" value={version} onChange={e=>setVersion(Number(e.target.value))}/></label>
          <label>Status
            <select value={status} onChange={e=>setStatus(e.target.value as PromptStatus)}>
              <option value="rascunho">Rascunho</option>
              <option value="publicado">Publicado</option>
              <option value="inativo">Inativo</option>
            </select>
          </label>
        </div>

        {error&&<p className="error">{error}</p>}

        <div className="form-actions">
          {editingId&&<button type="button" className="secondary-button compact" onClick={reset}>Cancelar</button>}
          <button className="primary-button compact" type="submit"><Save size={17}/>{editingId?'Salvar alterações':'Cadastrar prompt'}</button>
        </div>
      </form>

      <div className="prompt-list-panel">
        <div className="form-title"><BrainCircuit size={18}/><b>Prompts cadastrados</b><span className="count-badge">{items.length}</span></div>

        {loading
          ? <p className="muted">Carregando prompts...</p>
          : items.length===0
            ? <div className="empty-admin"><BrainCircuit/><b>Nenhum prompt cadastrado</b><small>Use o formulário ao lado para cadastrar o primeiro prompt.</small></div>
            : <div className="prompt-list">{items.map(item=>
                <article className="prompt-item" key={item.id}>
                  <div className="prompt-item-top">
                    <div><strong>{item.title}</strong><small>{item.area} · {item.perspective}</small></div>
                    <span className={`status-chip ${item.status}`}>{item.status}</span>
                  </div>
                  <p>{item.purpose}</p>
                  <div className="prompt-item-bottom">
                    <small>Versão {item.version || 1}</small>
                    <div>
                      <button onClick={()=>edit(item)} title="Editar"><Pencil size={16}/></button>
                      <button onClick={()=>remove(item.id)} title="Excluir"><Trash2 size={16}/></button>
                    </div>
                  </div>
                </article>)}</div>}
      </div>
    </div>
  </>
}

export default App
