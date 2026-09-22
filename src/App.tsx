import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from 'firebase/auth'
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { BrainCircuit, Check, ChevronRight, Download, FileText, LockKeyhole, Moon, Pencil, Plus, Save, ShieldCheck, Sun, Trash2, UploadCloud, X } from 'lucide-react'
import { auth, db, firebaseConfigured } from './firebase'

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
  Criminal: ['Defesa', 'Acusação', 'Assistente de acusação'],
  Ambiental: ['Empresa / Autuado', 'Autor / Órgão fiscalizador'],
  Tributário: ['Contribuinte', 'Fazenda Pública'],
  Administrativo: ['Administrado', 'Administração Pública'],
  Previdenciário: ['Segurado', 'INSS'],
  Consumidor: ['Consumidor', 'Fornecedor'],
  Família: ['Requerente', 'Requerido'],
  Empresarial: ['Autor / Credor', 'Réu / Devedor']
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
  'Dividindo o PDF em lotes de até 170 páginas',
  'Extraindo e catalogando os documentos',
  'Construindo a linha do tempo processual',
  'Confrontando alegações, provas e decisões',
  'Elaborando a análise jurídica global',
  'Calculando o cenário percentual de risco',
  'Preparando o relatório final'
]

function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('p360-theme') !== 'light')
  const [file, setFile] = useState<File | null>(null)
  const [area, setArea] = useState<Area>('Trabalhista')
  const [perspective, setPerspective] = useState('Reclamada')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [complete, setComplete] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminUser, setAdminUser] = useState<User | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('p360-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, user => setAdminUser(user?.email === ADMIN_EMAIL ? user : null))
  }, [])

  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])

  const stage = useMemo(() => stages[Math.min(stages.length - 1, Math.floor(progress / (100 / stages.length)))], [progress])

  function changeArea(next: Area) {
    setArea(next)
    setPerspective(perspectives[next][0])
  }

  function startAnalysis() {
    if (!file) return
    setProgress(0)
    setComplete(false)
    setProcessing(true)
    timer.current = window.setInterval(() => {
      setProgress(value => {
        const next = Math.min(100, value + 2)
        if (next === 100 && timer.current) {
          window.clearInterval(timer.current)
          window.setTimeout(() => { setProcessing(false); setComplete(true) }, 900)
        }
        return next
      })
    }, 130)
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
          <p>Envie o PDF, selecione a perspectiva e receba uma análise estruturada, rastreável e orientada à área jurídica correta.</p>
        </section>

        <section className="workspace-card">
          <div className="step-heading"><span>1</span><div><b>Envie o processo</b><small>Arquivo único em PDF. A divisão em lotes será automática.</small></div></div>
          <label className={`dropzone ${file ? 'has-file' : ''}`}>
            <input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            {file ? <><FileText size={34}/><b>{file.name}</b><small>{(file.size / 1024 / 1024).toFixed(2)} MB · PDF selecionado</small></> : <><UploadCloud size={38}/><b>Arraste o processo ou selecione o PDF</b><small>O sistema organizará os lotes de até 170 páginas</small></>}
          </label>

          <div className="step-heading second"><span>2</span><div><b>Escolha a área e a perspectiva</b><small>Cada opção acionará seu próprio conjunto de prompts especializados.</small></div></div>
          <div className="form-grid">
            <label>Área do Direito<select value={area} onChange={e => changeArea(e.target.value as Area)}>{Object.keys(perspectives).map(item => <option key={item}>{item}</option>)}</select></label>
            <label>Perspectiva<select value={perspective} onChange={e => setPerspective(e.target.value)}>{perspectives[area].map(item => <option key={item}>{item}</option>)}</select></label>
          </div>
          <button className="primary-button" disabled={!file} onClick={startAnalysis}>Iniciar análise completa <ChevronRight size={18}/></button>
        </section>

        {complete && <AnalysisResult area={area} perspective={perspective} fileName={file?.name ?? ''} />}

        <section className="trust-row">
          <span><ShieldCheck/> Rastreabilidade documental</span><span><LockKeyhole/> Prompts protegidos</span><span><BrainCircuit/> Diagnóstico somente após leitura integral</span>
        </section>
      </main>

      <footer><span>© 2026 Processo 360 IA</span><button onClick={() => setAdminOpen(true)}>Área ADM</button></footer>

      {processing && <div className="processing-overlay" role="dialog" aria-modal="true" aria-label="Análise em andamento">
        <div className="processing-inner">
          <BrainLoader />
          <div className="live-progress"><strong>{progress}%</strong><div className="progress-track"><i style={{width:`${progress}%`}} /></div><span>{stage}...</span></div>
        </div>
      </div>}

      {adminOpen && <AdminModal user={adminUser} onUser={setAdminUser} onClose={() => setAdminOpen(false)} />}
    </div>
  )
}

function AnalysisResult({area,perspective,fileName}:{area:Area;perspective:string;fileName:string}) {
  return <section className="analysis-result" id="analysis-result">
    <div className="analysis-toolbar no-print">
      <div><span className="eyebrow"><FileText size={16}/> Resultado da análise</span><h2>Relatório jurídico consolidado</h2></div>
      <button className="export-button" onClick={() => window.print()}><Download size={18}/> Exportar análise em PDF</button>
    </div>
    <div className="analysis-meta">
      <span><b>Arquivo:</b> {fileName}</span><span><b>Área:</b> {area}</span><span><b>Perspectiva:</b> {perspective}</span>
    </div>
    <div className="analysis-grid">
      <article><h3>1. Resumo executivo</h3><p>Este espaço receberá a síntese do processo, situação atual, teses centrais e pontos críticos identificados pela análise integral.</p></article>
      <article><h3>2. Linha do tempo processual</h3><p>Eventos relevantes serão organizados cronologicamente, com referência aos documentos e atos processuais correspondentes.</p></article>
      <article><h3>3. Alegações, provas e decisões</h3><p>O sistema confrontará alegações das partes com documentos, provas, decisões e demais elementos constantes dos autos.</p></article>
      <article><h3>4. Análise jurídica global</h3><p>As conclusões serão produzidas após a consolidação integral dos lotes, observando a área e a perspectiva selecionadas.</p></article>
      <article><h3>5. Riscos e pontos de atenção</h3><p>Serão apresentados os fatores favoráveis, desfavoráveis, lacunas probatórias e riscos jurídicos encontrados.</p></article>
      <article><h3>6. Conclusão e estratégia</h3><p>O relatório final apresentará síntese conclusiva, providências sugeridas e referências aos elementos que sustentam cada conclusão.</p></article>
    </div>
    <p className="analysis-placeholder">Modelo visual pronto. O conteúdo será substituído pela análise produzida pela IA quando o motor jurídico estiver conectado.</p>
  </section>
}

function BrainLoader() {
  const nodes = [[50,18],[35,27],[65,27],[26,41],[50,38],[74,41],[22,58],[39,55],[61,55],[78,58],[31,72],[50,69],[69,72],[41,84],[59,84]]
  return <div className="brain-loader" aria-hidden="true">
    <div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="orbit orbit-c"/>
    <svg viewBox="0 0 100 100">
      <defs><filter id="glow"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <path className="brain-outline" d="M49 13C38 8 28 16 28 26 18 29 15 41 21 49 14 59 20 71 30 73c0 11 10 18 19 12V13Zm2 0c11-5 21 3 21 13 10 3 13 15 7 23 7 10 1 22-9 24 0 11-10 18-19 12V13Z"/>
      <g className="circuits" filter="url(#glow)">
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
    e.preventDefault(); setError('')
    if (!auth) { setError('Configure as credenciais do Firebase para ativar o login.'); return }
    setLoading(true)
    try {
      const credential=await signInWithEmailAndPassword(auth,ADMIN_EMAIL,password)
      if (credential.user.email !== ADMIN_EMAIL) { await signOut(auth); throw new Error('unauthorized') }
      onUser(credential.user)
    } catch { setError('E-mail ou senha inválidos, ou acesso não autorizado.') }
    finally { setLoading(false) }
  }

  async function logout(){ if(auth) await signOut(auth); onUser(null) }

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
    if(!db){setLoading(false);setError('Firestore não configurado.');return}
    const q=query(collection(db,'prompts'),orderBy('updatedAt','desc'))
    return onSnapshot(q,snap=>{
      setItems(snap.docs.map(d=>({id:d.id,...d.data()} as PromptItem)))
      setLoading(false)
    },()=>{setLoading(false);setError('Não foi possível carregar os prompts. Verifique as regras do Firestore.')})
  },[])

  function changeArea(next:Area){setArea(next);setPerspective(perspectives[next][0])}
  function reset(){setEditingId(null);setTitle('');setArea('Trabalhista');setPerspective('Reclamada');setPurpose(promptPurposes[0]);setContent('');setVersion(1);setStatus('rascunho')}

  function edit(item:PromptItem){
    setEditingId(item.id);setTitle(item.title);setArea(item.area);setPerspective(item.perspective);setPurpose(item.purpose);setContent(item.content);setVersion(item.version || 1);setStatus(item.status || 'rascunho')
  }

  async function save(e:FormEvent){
    e.preventDefault();setError('')
    if(!db)return
    const payload={title:title.trim(),area,perspective,purpose,content:content.trim(),version:Number(version)||1,status,updatedAt:serverTimestamp(),updatedBy:user.email}
    try{
      if(editingId) await updateDoc(doc(db,'prompts',editingId),payload)
      else await addDoc(collection(db,'prompts'),{...payload,createdAt:serverTimestamp(),createdBy:user.email})
      reset()
    }catch{setError('Não foi possível salvar. Confirme se o Firestore está criado e com as regras publicadas.')}
  }

  async function remove(id:string){
    if(!db || !window.confirm('Excluir este prompt?')) return
    try{await deleteDoc(doc(db,'prompts',id)); if(editingId===id)reset()}catch{setError('Não foi possível excluir o prompt.')}
  }

  return <>
    <div className="admin-header">
      <div><span className="admin-badge"><ShieldCheck/> Administração</span><h2>Painel de prompts</h2><p className="muted">Cadastre o comando usado em cada etapa, área e perspectiva da análise.</p></div>
      <button className="secondary-button compact" onClick={onLogout}>Sair</button>
    </div>

    <div className="admin-layout">
      <form className="prompt-form" onSubmit={save}>
        <div className="form-title"><Plus size={18}/><b>{editingId?'Editar prompt':'Novo prompt'}</b></div>
        <label>Título<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ex.: Análise global - defesa da reclamada" required /></label>
        <div className="admin-form-grid">
          <label>Área<select value={area} onChange={e=>changeArea(e.target.value as Area)}>{Object.keys(perspectives).map(a=><option key={a}>{a}</option>)}</select></label>
          <label>Perspectiva<select value={perspective} onChange={e=>setPerspective(e.target.value)}>{perspectives[area].map(p=><option key={p}>{p}</option>)}</select></label>
        </div>
        <label>Finalidade<select value={purpose} onChange={e=>setPurpose(e.target.value)}>{promptPurposes.map(p=><option key={p}>{p}</option>)}</select></label>
        <label>Texto do prompt<textarea value={content} onChange={e=>setContent(e.target.value)} rows={12} placeholder="Cole aqui o prompt completo que a IA deverá usar nesta etapa..." required /></label>
        <div className="admin-form-grid">
          <label>Versão<input type="number" min="1" value={version} onChange={e=>setVersion(Number(e.target.value))}/></label>
          <label>Status<select value={status} onChange={e=>setStatus(e.target.value as PromptStatus)}><option value="rascunho">Rascunho</option><option value="publicado">Publicado</option><option value="inativo">Inativo</option></select></label>
        </div>
        {error&&<p className="error">{error}</p>}
        <div className="form-actions">
          {editingId&&<button type="button" className="secondary-button compact" onClick={reset}>Cancelar</button>}
          <button className="primary-button compact" type="submit"><Save size={17}/>{editingId?'Salvar alterações':'Cadastrar prompt'}</button>
        </div>
      </form>

      <div className="prompt-list-panel">
        <div className="form-title"><BrainCircuit size={18}/><b>Prompts cadastrados</b><span className="count-badge">{items.length}</span></div>
        {loading?<p className="muted">Carregando prompts...</p>:items.length===0?<div className="empty-admin"><BrainCircuit/><b>Nenhum prompt cadastrado</b><small>Use o formulário ao lado para cadastrar o primeiro prompt.</small></div>:
          <div className="prompt-list">{items.map(item=><article className="prompt-item" key={item.id}>
            <div className="prompt-item-top"><div><strong>{item.title}</strong><small>{item.area} · {item.perspective}</small></div><span className={`status-chip ${item.status}`}>{item.status}</span></div>
            <p>{item.purpose}</p>
            <div className="prompt-item-bottom"><small>Versão {item.version || 1}</small><div><button onClick={()=>edit(item)} title="Editar"><Pencil size={16}/></button><button onClick={()=>remove(item.id)} title="Excluir"><Trash2 size={16}/></button></div></div>
          </article>)}</div>}
      </div>
    </div>
  </>
}

export default App
