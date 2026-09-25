import { FormEvent, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from 'firebase/auth'
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { BrainCircuit, ChevronRight, Download, FileText, LockKeyhole, Moon, Pencil, Plus, Save, ShieldCheck, Sun, Trash2, UploadCloud, X } from 'lucide-react'
import { auth, db, firebaseConfigured } from './firebase'
import { analyzeUploadedProcess } from './ai'
import type { AnalysisReport } from './ai'

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
              : <><UploadCloud size={38}/><b>Arraste o processo ou selecione o PDF</b><small>O sistema dividirá automaticamente o PDF em lotes seguros por páginas e tamanho</small></>}
          </label>

          <div className="step-heading second"><span>2</span><div><b>Escolha a área e a perspectiva</b><small>Cada opção acionará seu próprio conjunto de prompts especializados.</small></div></div>
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

        {analysis && <AnalysisResult report={analysis} />}

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

function AnalysisResult({report}:{report:AnalysisReport}) {
  return <section className="analysis-result" id="analysis-result">
    <div className="analysis-toolbar no-print">
      <div>
        <span className="eyebrow"><FileText size={16}/> Resultado da análise</span>
        <h2>Relatório jurídico consolidado</h2>
      </div>
      <button className="export-button" onClick={() => exportAnalysisAsPdf(report)}><Download size={18}/> Exportar análise em PDF</button>
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
