import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { signInWithEmailAndPassword, signOut, User } from 'firebase/auth'
import { BrainCircuit, Check, ChevronRight, FileText, LockKeyhole, Moon, ShieldCheck, Sun, UploadCloud, X } from 'lucide-react'
import { auth, firebaseConfigured } from './firebase'

const ADMIN_EMAIL = 'fernandoazeredo64@gmail.com'

type Area = 'Trabalhista' | 'Cível' | 'Criminal' | 'Ambiental' | 'Tributário' | 'Administrativo' | 'Previdenciário' | 'Consumidor' | 'Família' | 'Empresarial'

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
          <img src="/assets/logo-processo-360-ia.svg" alt="Processo 360 IA" />
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

        {complete && <section className="result-card"><div className="success-icon"><Check/></div><div><h2>Análise demonstrativa concluída</h2><p>A estrutura visual está pronta. A execução jurídica será habilitada após a configuração dos prompts e do serviço de inteligência artificial.</p></div></section>}

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
  return <div className="modal-backdrop"><div className="admin-modal">
    <button className="modal-close" onClick={onClose} aria-label="Fechar"><X/></button>
    {user ? <><span className="admin-badge"><ShieldCheck/> Administração</span><h2>Painel de prompts</h2><p className="muted">Acesso autorizado para {user.email}.</p><div className="empty-admin"><BrainCircuit/><b>Nenhum prompt publicado</b><small>O cadastro e o versionamento de prompts serão habilitados na próxima etapa.</small></div><button className="secondary-button" onClick={logout}>Sair da Área ADM</button></> : <form onSubmit={login}><span className="admin-badge"><LockKeyhole/> Acesso restrito</span><h2>Área ADM</h2><p className="muted">Gerenciamento de prompts, versões e configurações.</p><label>E-mail<input value={ADMIN_EMAIL} readOnly /></label><label>Senha<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoFocus /></label>{error&&<p className="error">{error}</p>}<button className="primary-button" disabled={loading}>{loading?'Entrando...':'Entrar'}</button>{!firebaseConfigured&&<small className="config-note">Login aguardando configuração do Firebase Authentication.</small>}</form>}
  </div></div>
}

export default App
