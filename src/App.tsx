import { FormEvent, useEffect, useState } from 'react'
import { createUserWithEmailAndPassword, GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, User } from 'firebase/auth'
import { addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore'
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronRight, CreditCard, Download, FilePenLine, FileText, LockKeyhole, Moon, Pencil, Plus, Save, Search, ShieldCheck, Sun, Trash2, UploadCloud, Users, X } from 'lucide-react'
import { adminAuth, adminDb, adminFunctions, auth, db, firebaseConfigured, functions } from './firebase'
import { httpsCallable } from 'firebase/functions'
import { analyzeUploadedProcess } from './ai'
import type { AnalysisReport } from './ai'
import { confirmClaimInOriginal, generateLegalPiece, pieceTypeOptions, suggestPieceType } from './pieces'
import type { LegalPieceDraft, PieceClaim, ProfessionalProfile } from './pieces'
import { chargeAnalysis, chargePiece, consumeForcedAnalysisFailure, formatBRL, quoteAnalysis, quotePiece, refundCharge } from './wallet'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { WalletRecord, WalletStatus } from './wallet'

const ADMIN_EMAIL = 'fernandoazeredo64@gmail.com'
const APP_BUILD = String(import.meta.env.VITE_APP_BUILD || 'dev')

type Area = 'Trabalhista' | 'Cível' | 'Criminal' | 'Ambiental' | 'Tributário' | 'Administrativo' | 'Previdenciário' | 'Consumidor' | 'Família' | 'Empresarial'
type PromptArea = Area | 'Global'
type PromptStatus = 'rascunho' | 'publicado' | 'inativo'
type WalletConfig = {
  analysisMinimumCostCents: number
  analysisCostPerPageCents: number
  pieceCostCents: number
  marginMultiplier: number
  package1Cents: number
  package1Url: string
  package2Cents: number
  package2Url: string
  package3Cents: number
  package3Url: string
  paymentInstructions?: string
  lowBalanceWarningCents: number
  supportContact?: string
}

type WalletLedgerEntry = {
  id: string
  uid: string
  operation: string
  direction: 'credit' | 'debit' | 'neutral'
  amountCents: number
  balanceBeforeCents?: number
  balanceAfterCents?: number
  createdAt?: any
  reason?: string | null
  metadata?: { pageCount?: number; fileName?: string | null; pieceType?: string | null; processNumber?: string | null }
  relatedOperation?: string | null
  relatedChargeId?: string | null
}


type AIUsageEntry = {
  id: string
  uid: string
  operation: 'analysis' | 'piece' | string
  context?: string
  model?: string
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  createdAt?: any
}

type PromptItem = {
  id: string
  title: string
  area: PromptArea
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
  'Relatório final',
  'Motor B — Base Global',
  'Motor B — Trabalhista — Reclamada — Contestação / Defesa',
  'Motor B — Trabalhista — Reclamante — Petição Inicial',
  'Motor B — Validador Factual',
  'Motor B — Revisor Jurídico'
]

const promptPerspectives: Record<PromptArea, string[]> = {
  Global: ['Global'],
  ...perspectives
}

function walletOperationLabel(operation:string) {
  const labels:Record<string,string> = {
    recarga: 'Recarga',
    recarga_admin: 'Recarga',
    ajuste_saldo: 'Ajuste de saldo',
    ajuste_admin: 'Ajuste de saldo',
    ajuste_saldo_credito: 'Ajuste adm (crédito)',
    ajuste_saldo_debito: 'Ajuste adm (débito)',
    analise_processo: 'Análise',
    geracao_peca: 'Peça jurídica',
    estorno: 'Estorno'
  }
  return labels[operation] || 'Movimentação'
}

function parseCurrencyInput(raw:string) {
  const value=String(raw||'').trim()
  if(!value) return NaN
  const normalized=value.includes(',')
    ? value.replace(/\./g,'').replace(',','.')
    : value
  return Number(normalized)
}

function scrollToAlert(id:string) {
  const reveal = () => {
    const target=document.getElementById(id)
    if(!target) return
    target.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'})
    target.focus({preventScroll:true})
  }

  // O alerta é renderizado após a atualização do estado. Repetimos a tentativa
  // por um curto período para cobrir celulares/navegadores que concluem o layout
  // depois do primeiro frame.
  window.requestAnimationFrame(reveal)
  window.setTimeout(reveal,120)
  window.setTimeout(reveal,320)
}

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

  useEffect(() => {
    if (!analysisError) return
    scrollToAlert('analysis-error-box')
  }, [analysisError])
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminClientView, setAdminClientView] = useState(false)
  const [walletTopupOpen, setWalletTopupOpen] = useState(false)
  const [walletInfoOpen, setWalletInfoOpen] = useState(false)
  const [ledgerExpanded, setLedgerExpanded] = useState(false)
  const [adminUser, setAdminUser] = useState<User | null>(null)
  const [appUser, setAppUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [wallet, setWallet] = useState<WalletRecord | null>(null)
  const [walletReady, setWalletReady] = useState(false)
  const [quote, setQuote] = useState<{pageCount:number;priceCents:number}|null>(null)
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [walletLedger, setWalletLedger] = useState<WalletLedgerEntry[]>([])
  const [walletConfig, setWalletConfig] = useState<WalletConfig>({analysisMinimumCostCents:0,analysisCostPerPageCents:0,pieceCostCents:0,marginMultiplier:3,package1Cents:4000,package1Url:'https://payment-link-v3.ton.com.br/pl_L4oBjJNOkKyEJLGCrvCjO31nA9pG78db',package2Cents:8000,package2Url:'https://payment-link-v3.ton.com.br/pl_4n9ELgN872OXmzD9cyT1RMvDdBbxzGaj',package3Cents:12000,package3Url:'https://payment-link-v3.ton.com.br/pl_1wy7Jor82XxB8OEULRIqGdGALMQKzY4N',paymentInstructions:'',lowBalanceWarningCents:1000,supportContact:''})

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('p360-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!auth) {
      setAuthReady(true)
      return
    }
    return onAuthStateChanged(auth, user => {
      setAppUser(user)
      setAdminUser(user?.email === ADMIN_EMAIL ? user : null)
      setAuthReady(true)
    })
  }, [])

  useEffect(() => {
    if (!appUser || !db) {
      setWallet(null)
      setWalletReady(!appUser)
      return
    }

    setWalletReady(false)
    const walletRef = doc(db, 'wallets', appUser.uid)
    let creating = false

    return onSnapshot(walletRef, async snap => {
      if (snap.exists()) {
        setWallet({ id: snap.id, ...snap.data() } as WalletRecord)
        setWalletReady(true)
        return
      }

      if (creating) return
      creating = true
      try {
        await setDoc(walletRef, {
          uid: appUser.uid,
          email: String(appUser.email || '').toLowerCase(),
          displayName: appUser.displayName || '',
          status: 'ativo',
          balanceCents: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      } catch (error) {
        console.error('[Processo 360 IA] Falha ao criar carteira.', error)
        setWalletReady(true)
      }
    }, error => {
      console.error('[Processo 360 IA] Falha ao consultar carteira.', error)
      setWalletReady(true)
    })
  }, [appUser?.uid])

  useEffect(()=>{
    if(!db || !appUser) return
    return onSnapshot(doc(db,'walletConfig','main'), snap=>{
      if(snap.exists()) setWalletConfig(prev=>({...prev,...snap.data()} as WalletConfig))
    })
  },[appUser?.uid])

  useEffect(()=>{
    if(!db || !appUser || appUser.email===ADMIN_EMAIL){
      setWalletLedger([])
      return
    }
    const ledgerQuery=query(collection(db,'walletLedger'),where('uid','==',appUser.uid))
    return onSnapshot(ledgerQuery,snap=>{
      const rows=snap.docs.map(item=>({id:item.id,...item.data()} as WalletLedgerEntry))
      rows.sort((a,b)=>Number(b.createdAt?.toMillis?.()||0)-Number(a.createdAt?.toMillis?.()||0))
      setWalletLedger(rows)
    },error=>console.error('[Processo 360 IA] Falha ao carregar extrato da carteira.',error))
  },[appUser?.uid])

  useEffect(()=>{
    let cancelled=false
    setQuote(null)
    setQuoteError('')
    if(!file || !appUser || (appUser.email===ADMIN_EMAIL && !adminClientView)) return

    setQuoteBusy(true)
    quoteAnalysis(file)
      .then(result=>{if(!cancelled) setQuote(result)})
      .catch((error:any)=>{
        if(cancelled) return
        const message=String(error?.message||'')
        console.error('[Processo 360 IA][Carteira] Falha ao cotar análise', {
          code: error?.code || null,
          message,
          details: error?.details || null
        })
        if(message.includes('PDF_NO_READABLE_CONTENT') || message.includes('PDF_INVALID_OR_UNREADABLE')) {
          setQuoteError('Arquivo sem conteúdo legível, nada foi cobrado.')
        } else if(message.includes('WALLET_PRICING_NOT_CONFIGURED') || message.includes('tabela de custos') || message.includes('failed-precondition')) {
          setQuoteError('Preço não configurado. Serviço temporariamente indisponível.')
        } else {
          setQuoteError('Não foi possível calcular o valor desta análise.')
        }
      })
      .finally(()=>{if(!cancelled) setQuoteBusy(false)})

    return ()=>{cancelled=true}
  },[file,appUser?.uid,adminClientView])



  function changeArea(next: Area) {
    setArea(next)
    setPerspective(perspectives[next][0])
  }

  async function startAnalysis() {
    if (!file) return
    const selectedArea = area
    const selectedPerspective = perspective
    setAnalysisError('')
    setAnalysis(null)

    setProgress(0)
    setProcessingStage(stages[0])
    setProcessing(true)

    let chargeId = ''
    let chargedPriceCents = 0
    try {
      let billableQuote = quote
      if (appUser?.email !== ADMIN_EMAIL) {
        if (!wallet || wallet.status !== 'ativo') {
          throw new Error('WALLET_BLOCKED')
        }
        billableQuote = quote || await quoteAnalysis(file)
        if (wallet.balanceCents < billableQuote.priceCents) {
          throw new Error('WALLET_INSUFFICIENT')
        }
        const charge = await chargeAnalysis(billableQuote.pageCount, file.name, billableQuote.priceCents)
        chargeId = charge.chargeId
        chargedPriceCents = billableQuote.priceCents
        if (await consumeForcedAnalysisFailure()) {
          throw new Error('TEST_FORCED_ANALYSIS_FAILURE')
        }
      }

      const report = await analyzeUploadedProcess(file, selectedArea, selectedPerspective, (value, stage) => {
        setProgress(value)
        setProcessingStage(stage)
      })

      if (report.area !== selectedArea || report.perspective !== selectedPerspective) {
        throw new Error(`ANALYSIS_PERSPECTIVE_MISMATCH: solicitado ${selectedArea}/${selectedPerspective}, recebido ${report.area}/${report.perspective}`)
      }
      setAnalysis(report)
      window.setTimeout(() => {
        document.getElementById('analysis-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 150)
    } catch (error: any) {
      let refundConfirmed = false
      let refundedCents = 0
      if (chargeId) {
        try {
          const refund = await refundCharge(chargeId, 'Análise não concluída — valor devolvido.')
          refundConfirmed = Boolean(refund.refunded || refund.alreadyRefunded)
          refundedCents = Number(chargedPriceCents || 0)
        } catch (refundError) {
          console.error('[Processo 360 IA] Falha ao estornar cobrança da análise.', refundError)
        }
      }
      const rawMessage = error?.message ?? error
      let message = ''
      if (typeof rawMessage === 'string') message = rawMessage
      else {
        try { message = JSON.stringify(rawMessage) }
        catch { message = String(rawMessage || '') }
      }
      console.error('[Processo 360 IA] Falha na análise', message, error)
      if (message.includes('TEST_FORCED_ANALYSIS_FAILURE')) {
        setAnalysisError(refundConfirmed
          ? `Não foi possível concluir a análise. O valor de ${formatBRL(refundedCents)} foi devolvido ao seu saldo.`
          : 'Não foi possível concluir a análise. A devolução automática não pôde ser confirmada; consulte o extrato e contate o administrador.')
      } else if (message.includes('PDF_NO_READABLE_CONTENT') || message.includes('PDF_INVALID_OR_UNREADABLE')) {
        setAnalysisError('Arquivo sem conteúdo legível, nada foi cobrado.')
      } else if (message.includes('ANALYSIS_PERSPECTIVE_MISMATCH')) {
        setAnalysisError('A perspectiva retornada não corresponde à seleção feita. Nenhum resultado divergente foi apresentado.')
      } else if (message.includes('WALLET_INSUFFICIENT') || message.includes('Saldo insuficiente')) {
        setAnalysisError('Saldo insuficiente para realizar esta análise. Adicione saldo à sua carteira e tente novamente.')
      } else if (message.includes('WALLET_PRICE_CHANGED')) {
        setAnalysisError('O preço desta análise foi atualizado. Recarregue a cotação e confirme novamente.')
      } else if (message.includes('WALLET_BLOCKED') || message.includes('carteira está inativa')) {
        setAnalysisError('Sua carteira está inativa ou bloqueada. Entre em contato com o administrador.')
      } else if (message.includes('ANALYSIS_CANCELLED')) {
        setAnalysisError('')
      } else if (message.includes('GEMINI_CREDIT_DEPLETED')) {
        setAnalysisError('O crédito/faturamento do provedor de IA não está disponível para concluir a análise. Regularize ou renove o crédito do Google/Firebase antes de tentar novamente.')
      } else if (message.includes('GEMINI_BILLING_STATE_MISMATCH')) {
        setAnalysisError('O Google retornou um estado de faturamento inconsistente para o projeto. Verifique o faturamento do Firebase/Google Cloud e tente novamente.')
      } else if (message.includes('GEMINI_RATE_LIMIT')) {
        setAnalysisError('O Gemini atingiu temporariamente um limite de requisições ou cota do serviço. Aguarde alguns instantes e tente novamente: os lotes já concluídos ficaram salvos para retomada automática.')
      } else if (message.includes('GEMINI_TEMPORARILY_BUSY')) {
        setAnalysisError('O Gemini está temporariamente com alta demanda. Tente novamente mais tarde; os lotes concluídos ficaram salvos para retomada.')
      } else if (message.includes('GEMINI_REQUEST_TIMEOUT')) {
        setAnalysisError('O Gemini não respondeu dentro do limite de 210 segundos. O lote em andamento não foi concluído; os lotes anteriores já finalizados permanecem salvos para retomada.')
      } else if (message.includes('GEMINI_PROJECT_CONFIGURATION')) {
        setAnalysisError('A chamada ao Gemini foi recusada pela configuração do projeto Firebase/Google Cloud. Nenhum modelo alternativo incompatível será usado automaticamente.')
      } else if (message.includes('GEMINI_MODEL_UNAVAILABLE')) {
        setAnalysisError('Nenhum dos modelos Gemini configurados respondeu corretamente nesta tentativa. Tente novamente mais tarde.')
      } else if (message.includes('GEMINI_APP_CHECK_INVALID')) {
        setAnalysisError('O Firebase App Check rejeitou a chamada ao Gemini. Recarregue a página e tente novamente.')
      } else if (message.includes('FIREBASE_AI_NOT_READY')) {
        setAnalysisError('O Firebase AI Logic ainda não está configurado corretamente para o aplicativo.')
      } else {
        setAnalysisError(refundConfirmed
          ? `Não foi possível concluir a análise. O valor de ${formatBRL(refundedCents)} foi devolvido ao seu saldo.`
          : 'Não foi possível concluir a análise. ' + (message || 'Verifique a configuração do Gemini e tente novamente.'))
      }
    } finally {
      setProcessing(false)
    }
  }

  if (!authReady) {
    return null
  }

  if (!appUser) {
    return <LoginPage />
  }

  if (appUser.email !== ADMIN_EMAIL && !walletReady) {
    return null
  }

  if (appUser.email !== ADMIN_EMAIL && wallet?.status !== 'ativo') {
    return <WalletBlockedPage user={appUser} wallet={wallet} />
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="logo-light" src="/assets/logo-processo-360-ia.svg" alt="Processo 360 IA" />
          <img className="logo-dark" src="/assets/logo-processo-360-ia-dark.svg" alt="Processo 360 IA" />
        </div>
        <div className="topbar-actions">
          <span className="signed-user">{appUser.displayName || appUser.email || 'Usuário'}</span>
          {(appUser.email !== ADMIN_EMAIL || adminClientView) && adminClientView && <span className="client-preview-badge">Visualização do cliente</span>}
          <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Alternar tema">
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button className="secondary-button compact" onClick={() => auth && signOut(auth)}>Sair</button>
        </div>
      </header>

      <main>
        {(appUser.email !== ADMIN_EMAIL || adminClientView) && <section className="wallet-compact-card">
          <div className="wallet-compact-copy">
            <div className="wallet-compact-title-row">
              <h2>Créditos disponíveis</h2>
              <button className="wallet-info-button" type="button" aria-label="Informações sobre créditos" onClick={()=>setWalletInfoOpen(true)}>i</button>
            </div>
            <p>Seus créditos são usados para pagar pelos serviços da API Gemini antes do uso deles. Os créditos não são reembolsáveis e não expiram mensalmente. O saldo pode levar alguns minutos para refletir uma recarga, um uso ou um ajuste administrativo.</p>
          </div>
          <div className="wallet-compact-actions">
            <span>Saldo <b>{formatBRL(wallet?.balanceCents||0)}</b></span>
            <button className="buy-credits-button" type="button" onClick={()=>setWalletTopupOpen(true)}><CreditCard size={17}/> Comprar créditos</button>
          </div>
          {(() => {
            const minimum=Math.ceil(Number(walletConfig.analysisMinimumCostCents||0)*Number(walletConfig.marginMultiplier||3))
            return minimum>0 && (wallet?.balanceCents||0)<minimum
              ? <div className="wallet-low-warning compact">Saldo abaixo do valor mínimo de uma análise: {formatBRL(wallet?.balanceCents||0)}.</div>
              : null
          })()}
        </section>}
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

          {file && (appUser.email !== ADMIN_EMAIL || adminClientView) && <div className="operation-price-line">
            {quoteBusy
              ? <span>Calculando o valor da análise...</span>
              : quote
                ? <>
                    <span className="operation-price-main">{quote.pageCount} {quote.pageCount===1?'página':'páginas'} · <b>{formatBRL(quote.priceCents)}</b></span>
                    <span className={(wallet?.balanceCents||0) < quote.priceCents ? 'operation-balance missing' : 'operation-balance'}>
                      {(wallet?.balanceCents||0) < quote.priceCents
                        ? <>Faltam <b>{formatBRL(quote.priceCents-(wallet?.balanceCents||0))}</b></>
                        : <>Saldo {formatBRL(wallet?.balanceCents||0)}</>}
                    </span>
                  </>
                : quoteError
                  ? <span className="error">{quoteError}</span>
                  : null}
          </div>}

          {(appUser.email !== ADMIN_EMAIL && quote && (wallet?.balanceCents||0) < quote.priceCents)
            ? <button className="primary-button buy-required-button" type="button" onClick={()=>setWalletTopupOpen(true)}>
                <CreditCard size={18}/> Comprar créditos
              </button>
            : <button className="primary-button" disabled={!file || processing || adminClientView || (appUser.email !== ADMIN_EMAIL && !quote)} onClick={startAnalysis}>
                {adminClientView ? 'Visualização do cliente — análise desativada' : processing ? 'Analisando processo...' : 'Iniciar análise completa'} <ChevronRight size={18}/>
              </button>}

          {analysisError && (
            <div className="analysis-error-actions" id="analysis-error-box" tabIndex={-1}>
              <p className="analysis-error">{analysisError}</p>
              <button type="button" className="retry-analysis-button" disabled={!file || processing} onClick={startAnalysis}>
                Tentar novamente
              </button>
            </div>
          )}
        </section>

        {appUser.email !== ADMIN_EMAIL && walletLedger.length > 0 && <details className="wallet-statement">
          <summary>Extrato da carteira</summary>
          <div className="wallet-statement-list compact-ledger">
            {(() => {
              const refunds=new Map<string,WalletLedgerEntry>()
              walletLedger.filter(item=>item.operation==='estorno' && item.relatedChargeId).forEach(item=>refunds.set(String(item.relatedChargeId),item))
              const ordered:WalletLedgerEntry[]=[]
              const used=new Set<string>()
              walletLedger.forEach(item=>{
                if(used.has(item.id) || item.operation==='estorno') return
                ordered.push(item); used.add(item.id)
                const refund=refunds.get(item.id)
                if(refund){ordered.push(refund);used.add(refund.id)}
              })
              walletLedger.filter(item=>!used.has(item.id)).forEach(item=>ordered.push(item))
              const visibleEntries=ledgerExpanded?ordered:ordered.slice(0,10)
              const description=(entry:WalletLedgerEntry)=>{
                if(entry.operation==='analise_processo') return `Análise — ${entry.metadata?.fileName||'arquivo'}${entry.metadata?.pageCount ? ` (${entry.metadata.pageCount} págs)` : ''}`
                if(entry.operation==='geracao_peca') return `Peça — ${entry.metadata?.pieceType||'Peça jurídica'}`
                if(entry.operation==='estorno') return entry.relatedOperation==='geracao_peca' ? 'Estorno — peça não concluída' : 'Estorno — análise não concluída'
                if(entry.operation==='recarga' || entry.operation==='recarga_admin') return 'Recarga'
                if(entry.operation.startsWith('ajuste_')) {
                  const reason=String(entry.reason||'').trim()
                  const generic=/^(ajuste|ajuste administrativo)$/i.test(reason)
                  return generic || !reason ? 'Ajuste administrativo' : `Ajuste administrativo — ${reason}`
                }
                return walletOperationLabel(entry.operation)
              }
              return <>
                <div className="ledger-head"><span>Data</span><span>Descrição</span><span>Valor</span><span>Saldo</span></div>
                {visibleEntries.map(entry=><div key={entry.id} className={`wallet-statement-row ${entry.direction==='credit'?'wallet-entry-credit':entry.direction==='debit'?'wallet-entry-debit':''} ${entry.operation==='estorno'?'refund-row':''}`}>
                  <span>{(entry.createdAt?.toDate?.().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) || '—').replace(',','')}</span>
                  <span className="wallet-entry-description">{description(entry)}</span>
                  <b>{entry.direction==='credit'?'+':entry.direction==='debit'?'-':''}{formatBRL(entry.amountCents||0)}</b>
                  <strong>{formatBRL(entry.balanceAfterCents||0)}</strong>
                </div>)}
                {ordered.length>10 && <button type="button" className="ledger-more-button" onClick={()=>setLedgerExpanded(v=>!v)}>{ledgerExpanded?'Mostrar menos':'Ver mais'}</button>}
              </>
            })()}
          </div>
        </details>}

        {analysis && <AnalysisResult report={analysis} originalFile={file} isAdmin={appUser.email===ADMIN_EMAIL} piecePriceCents={Math.ceil((walletConfig.pieceCostCents||0)*(walletConfig.marginMultiplier||3))} walletBalanceCents={wallet?.balanceCents||0} onRecharge={()=>setWalletTopupOpen(true)} user={appUser} />}

      </main>

      <footer>
        <span>© 2026 Processo 360 IA</span>
        <button
          className="footer-admin-link"
          onClick={() => {
            if (appUser.email === ADMIN_EMAIL) setAdminUser(appUser)
            else if (adminAuth?.currentUser?.email === ADMIN_EMAIL) setAdminUser(adminAuth.currentUser)
            setAdminOpen(true)
          }}
        >
          Área ADM
        </button>
        {adminUser && adminClientView && <button onClick={() => setAdminClientView(false)}>Sair da visualização do cliente</button>}
      </footer>

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

      {walletInfoOpen && <div className="wallet-modal-backdrop" role="dialog" aria-modal="true" aria-label="Informações sobre créditos">
        <section className="wallet-modal wallet-info-modal">
          <button className="wallet-modal-close" type="button" onClick={()=>setWalletInfoOpen(false)} aria-label="Fechar"><X size={20}/></button>
          <h2>Como funcionam os créditos</h2>
          <p>O valor de cada operação aparece antes de você confirmar. Em caso de falha na análise ou na peça, o valor cobrado é estornado automaticamente.</p>
          <p>A recarga continua manual: após o pagamento, envie o comprovante{walletConfig.supportContact?.trim() ? <> para <b>{walletConfig.supportContact.trim()}</b></> : null}. O crédito é lançado em até 24 horas.</p>
          <p>Os créditos não expiram mensalmente e o saldo não é zerado.</p>
        </section>
      </div>}

      {(appUser.email !== ADMIN_EMAIL || adminClientView) && walletTopupOpen &&
        <BuyCreditsModal config={walletConfig} balanceCents={wallet?.balanceCents || 0} onClose={()=>setWalletTopupOpen(false)} />}
      {adminOpen && <AdminModal user={adminUser} onUser={setAdminUser} onClose={() => setAdminOpen(false)} onViewAsClient={()=>{setAdminOpen(false);setAdminClientView(true)}} />}
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

function exportAnalysisAsPdf(report: AnalysisReport) {
  const fileName = buildExportFileName(report)

  // Abre a janela imediatamente no mesmo gesto do clique.
  // Em navegadores móveis, especialmente Safari/iOS, adiar window.print()
  // após awaits/requestAnimationFrame pode fazer o diálogo de impressão não abrir.
  const printWindow = window.open('', '_blank', 'width=900,height=800')
  if (!printWindow) {
    window.alert('Não foi possível abrir a impressão. Verifique se o navegador está bloqueando pop-ups.')
    return
  }

  const source = document.getElementById('analysis-result')
  if (!source) {
    printWindow.close()
    window.alert('O relatório não está disponível para exportação.')
    return
  }

  const clone = source.cloneNode(true) as HTMLElement

  // A exportação da análise não deve incluir controles nem o módulo da peça.
  clone.querySelectorAll('.no-print,[data-ui-only="true"],#piece-module,.piece-module').forEach(node => node.remove())

  const styleNodes = Array.from(
    document.querySelectorAll('link[rel="stylesheet"],style')
  ).map(node => node.outerHTML).join('\n')

  printWindow.document.open()
  printWindow.document.write(`<!doctype html>
<html lang="pt-BR" class="pdf-exporting" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(fileName)}</title>
${styleNodes}
<style>
  html,body{
    margin:0!important;
    padding:0!important;
    background:#fff!important;
    color:#111!important;
  }
  body{
    width:100%!important;
  }
  #analysis-result{
    margin:0!important;
    padding:0!important;
    width:100%!important;
    max-width:none!important;
  }
  .analysis-toolbar,
  .analysis-toolbar-actions,
  .piece-module,
  .no-print,
  [data-ui-only="true"]{
    display:none!important;
  }
  @media print{
    html,body{
      background:#fff!important;
      color:#111!important;
      -webkit-print-color-adjust:exact!important;
      print-color-adjust:exact!important;
    }
  }
</style>
</head>
<body>
${clone.outerHTML}
<script>
  window.addEventListener('load', function () {
    setTimeout(function () {
      window.focus();
      window.print();
    }, 120);
  });
  window.addEventListener('afterprint', function () {
    window.close();
  });
<\/script>
</body>
</html>`)
  printWindow.document.close()
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function ensureCurrentProductionBuild() {
  if (APP_BUILD === 'dev') return true
  try {
    const response = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) return true
    const latest = await response.json()
    const latestBuild = String(latest?.build || '')
    if (latestBuild && latestBuild !== APP_BUILD) {
      window.alert('Há uma versão mais nova publicada. A página será recarregada antes da exportação para evitar gerar PDF com código antigo.')
      const url = new URL(window.location.href)
      url.searchParams.set('v', latestBuild.slice(0, 12))
      window.location.replace(url.toString())
      return false
    }
  } catch (error) {
    console.warn('[Processo 360 IA] Falha ao conferir versão publicada.', error)
  }
  return true
}

function pieceHasPending(piece: LegalPieceDraft) {
  const text = piece.sections.map(section => `${section.title}\n${section.content}`).join('\n')
  return /⚠\s*REVISAR|\[(?:VALOR|RG|NÚMERO|NUMERO|CEP|CPF|CNPJ|ENDEREÇO|DATA|DADO A CONFIRMAR)[^\]]*\]/i.test(text)
    || piece.validation.unconfirmed > 0
    || piece.validation.conflicting > 0
}

function normalizeWordSignature(text: string) {
  return String(text || '')
    .replace(/\s+(Advogado(?:\(a\))?\s*-?\s*OAB\/[A-Z]{2}\s*[\d.\-]+)/gi, '\n$1')
    .replace(/(OAB\/[A-Z]{2}\s*[\d.\-]+)(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/g, '$1\n')
}

function buildPieceFileName(report: AnalysisReport, pieceType: string) {
  const process = report.processNumber && report.processNumber !== 'Informação não constante nos dados fornecidos'
    ? report.processNumber
    : `processo-${report.analysisId.slice(0, 8)}`
  return `${process} - ${pieceType}`.replace(/[\\/:*?"<>|]/g, '-').trim()
}

async function exportPieceAsPdf(report: AnalysisReport, piece: LegalPieceDraft) {
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

  if (pieceHasPending(piece)) {
    drawWrapped('RASCUNHO DE PEÇA PROCESSUAL - Há pendências que exigem revisão jurídica antes do protocolo.', boldFont, 10, 15, { centered: true })
    y -= 10
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
  const pdfBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileName}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportPieceAsWord(report: AnalysisReport, piece: LegalPieceDraft) {
  const banner = 'RASCUNHO DE PEÇA PROCESSUAL — Há pendências que exigem revisão jurídica antes do protocolo.'
  const sections = piece.sections
    .filter(section => section.title.trim() || section.content.trim())
    .map(section => `<section><h2>${escapeHtml(section.title)}</h2><div>${escapeHtml(normalizeWordSignature(section.content)).replace(/\n/g, '<br>')}</div></section>`)
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.5;color:#111;margin:2.5cm}
    h1{text-align:center;font-size:14pt;margin:0 0 20pt}
    h2{font-size:12pt;margin:18pt 0 8pt;border-bottom:1px solid #bbb;padding-bottom:4pt}
    .warning{font-size:10pt;border:1px solid #bbb;padding:8pt;margin-bottom:18pt}
    section{margin-bottom:12pt}
  </style></head><body><div class="p360-print-warning">${escapeHtml(banner)}</div><h1>${escapeHtml(piece.title)}</h1>${sections}</body></html>`

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

function AnalysisResult({report, originalFile, isAdmin, piecePriceCents, walletBalanceCents, onRecharge, user}:{report:AnalysisReport;originalFile:File|null;isAdmin:boolean;piecePriceCents:number;walletBalanceCents:number;onRecharge:()=>void;user:User}) {
  const [pieceOpen, setPieceOpen] = useState(false)
  const [pieceType, setPieceType] = useState(() => suggestPieceType(report.area, report.perspective))
  const [piece, setPiece] = useState<LegalPieceDraft | null>(null)
  const [pieceBusy, setPieceBusy] = useState(false)
  const [pieceStage, setPieceStage] = useState('')
  const [pieceError, setPieceError] = useState('')

  useEffect(() => {
    if (!pieceError) return
    scrollToAlert('piece-error-box')
  }, [pieceError])
  const [confirmingClaim, setConfirmingClaim] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Record<string, string>>({})
  const [professionalProfile, setProfessionalProfile] = useState<ProfessionalProfile>({ name: '', oab: '', address: '', email: '' })
  const [profileStatus, setProfileStatus] = useState('')
  const [profileEditing, setProfileEditing] = useState(false)
  const [pieceQuoteCents, setPieceQuoteCents] = useState(piecePriceCents)
  const [pieceQuoteError, setPieceQuoteError] = useState('')

  useEffect(() => {
    if (!pieceOpen) return
    const timer = window.setTimeout(() => {
      document.getElementById('piece-module')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [pieceOpen])

  useEffect(() => {
    if (!db || !user.uid) return
    const firestore = db
    return onSnapshot(doc(firestore, 'professionalProfiles', user.uid), async snap => {
      if (snap.exists()) {
        const data = snap.data() as Partial<ProfessionalProfile> & { emailExplicitlySet?: boolean; legacyLoginEmailCleared?: boolean }
        const storedEmail = String(data.email || '').trim()
        const loginEmail = String(user.email || '').trim()
        const isLegacyLoginEmail = Boolean(
          storedEmail && loginEmail &&
          storedEmail.toLowerCase() === loginEmail.toLowerCase() &&
          data.emailExplicitlySet !== true &&
          data.legacyLoginEmailCleared !== true
        )

        // Versões antigas gravavam automaticamente o e-mail de autenticação como e-mail profissional.
        // Limpa esse legado uma única vez. Se o advogado quiser usar o mesmo e-mail profissional,
        // basta digitá-lo e salvar: a partir daí emailExplicitlySet=true preserva a escolha.
        if (isLegacyLoginEmail) {
          try {
            await setDoc(doc(firestore, 'professionalProfiles', user.uid), {
              email: '',
              emailExplicitlySet: false,
              legacyLoginEmailCleared: true,
              updatedAt: serverTimestamp()
            }, { merge: true })
          } catch (error) {
            console.error('[Processo 360 IA] Falha ao limpar e-mail profissional legado', error)
          }
        }

        setProfessionalProfile({
          name: String(data.name || ''),
          oab: String(data.oab || ''),
          address: String(data.address || ''),
          email: isLegacyLoginEmail ? '' : storedEmail
        })
      }
    })
  }, [user.uid])

  async function saveProfessionalProfile() {
    if (!db) return
    setProfileStatus('Salvando...')
    try {
      await setDoc(doc(db, 'professionalProfiles', user.uid), {
        ...professionalProfile,
        uid: user.uid,
        emailExplicitlySet: true,
        legacyLoginEmailCleared: true,
        updatedAt: serverTimestamp()
      }, { merge: true })
      setProfileStatus('Dados salvos.')
      setProfileEditing(false)
    } catch (error) {
      console.error('[Processo 360 IA] Falha ao salvar dados profissionais', error)
      setProfileStatus('Não foi possível salvar os dados.')
    }
  }

  const options = pieceTypeOptions(report.area, report.perspective)

  useEffect(()=>{
    if(!pieceOpen || isAdmin) {
      setPieceQuoteCents(piecePriceCents)
      setPieceQuoteError('')
      return
    }
    let cancelled=false
    quotePiece()
      .then(result=>{if(!cancelled){setPieceQuoteCents(result.priceCents);setPieceQuoteError('')}})
      .catch((error:any)=>{
        if(cancelled) return
        const message=String(error?.message||'')
        console.error('[Processo 360 IA][Carteira] Falha ao cotar peça', {
          code: error?.code || null,
          message,
          details: error?.details || null
        })
        setPieceQuoteError(message.includes('WALLET_PRICING_NOT_CONFIGURED') || message.includes('failed-precondition')
          ? 'Preço não configurado. Serviço temporariamente indisponível.'
          : 'Não foi possível consultar o preço da peça.')
      })
    return ()=>{cancelled=true}
  },[pieceOpen,isAdmin,piecePriceCents])

  async function handleGeneratePiece() {
    setPieceError('')
    setPiece(null)
    if (!professionalProfile.name.trim() || !professionalProfile.oab.trim()) {
      setPieceError('Cadastre o nome do advogado e a OAB antes de gerar a peça. Assim o sistema não criará assinatura com campos em branco.')
      return
    }
    if (!isAdmin && pieceQuoteCents > 0 && walletBalanceCents < pieceQuoteCents) {
      setPieceError('WALLET_INSUFFICIENT: saldo insuficiente para gerar a peça. Recarregue a carteira.')
      return
    }
    setPieceBusy(true)
    setPieceStage('Estruturando e redigindo o rascunho')
    let chargeId = ''
    try {
      if (!isAdmin) {
        const charge = await chargePiece(pieceType, report.processNumber, pieceQuoteCents)
        chargeId = charge.chargeId
      }
      window.setTimeout(() => setPieceStage('Validando fatos contra o relatório consolidado'), 900)
      const generated = await generateLegalPiece(report, pieceType, professionalProfile)
      setPiece(generated)
      setPieceStage('Rascunho validado')
      window.setTimeout(() => document.getElementById('piece-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    } catch (error: any) {
      let refundConfirmed = false
      let refundedCents = 0
      if (chargeId) {
        try {
          const refund = await refundCharge(chargeId, 'Peça jurídica não concluída — valor devolvido.')
          refundConfirmed = Boolean(refund.refunded || refund.alreadyRefunded)
          refundedCents = Number(pieceQuoteCents || 0)
        } catch (refundError) {
          console.error('[Processo 360 IA][Motor B] Falha ao estornar cobrança da peça.', refundError)
        }
      }
      console.error('[Processo 360 IA][Motor B] Falha', error)
      const message=String(error?.message||'')
      setPieceError(refundConfirmed
        ? `Não foi possível concluir a peça jurídica. O valor de ${formatBRL(refundedCents)} foi devolvido ao seu saldo.`
        : message.includes('WALLET_INSUFFICIENT') || message.includes('Saldo insuficiente') || message.includes('saldo insuficiente')
          ? 'Saldo insuficiente para gerar a peça jurídica. Adicione saldo à carteira.'
          : message.includes('WALLET_PRICE_CHANGED')
            ? 'O preço da peça foi atualizado. Feche e abra novamente esta etapa para consultar o valor atual.'
          : message.includes('PIECE_REPLICA_WITHOUT_DEFENSE')
            ? 'Não é possível gerar Réplica / Manifestação à contestação porque o relatório não demonstra contestação ou defesa efetivamente apresentada nos autos.'
            : 'Não foi possível gerar e validar o rascunho. ' + (message || 'Tente novamente.'))
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
        <button className="piece-launch-button" onClick={() => {
          if (!isAdmin && piecePriceCents>0 && walletBalanceCents<piecePriceCents) {
            setPieceError(`Saldo insuficiente (${formatBRL(piecePriceCents)}) — Comprar créditos.`)
          }
          setPieceOpen(true)
        }}><FilePenLine size={18}/> Gerar Peça Jurídica</button>
        <button className="export-button" onClick={() => exportAnalysisAsPdf(report)}><Download size={18}/> Exportar análise em PDF</button>
      </div>
    </div>

    <div className="analysis-meta">
      <span><b>Arquivo:</b> {report.fileName}</span>
      <span><b>Área:</b> {report.area}</span>
      <span><b>Perspectiva:</b> {report.perspective}</span>
      <span><b>Nº do processo:</b> {report.processNumber}</span>
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
          <h2>Gerar Peça Jurídica</h2>
        </div>
        <div className="piece-context">
          <span><b>Área:</b> {report.area}</span>
          <span><b>Perspectiva:</b> {report.perspective}</span>
        </div>
        <div className="professional-profile collapsed-profile">
          <div className="professional-profile-head">
            <div>
              <h3>Dados do advogado</h3>
              {!profileEditing && <small>{professionalProfile.name || 'Nome não informado'}{professionalProfile.oab ? ` · ${professionalProfile.oab}` : ''}</small>}
            </div>
            <button type="button" className="secondary-button compact" onClick={()=>setProfileEditing(v=>!v)}>{profileEditing?'Fechar':'Editar'}</button>
          </div>
          {profileEditing && <>
            <div className="form-grid">
              <label>Nome profissional<input value={professionalProfile.name} onChange={event => setProfessionalProfile(current => ({ ...current, name: event.target.value }))} placeholder="Nome do advogado" /></label>
              <label>OAB/UF<input value={professionalProfile.oab} onChange={event => setProfessionalProfile(current => ({ ...current, oab: event.target.value }))} placeholder="OAB/RJ 00.000" /></label>
              <label>Endereço profissional<input value={professionalProfile.address} onChange={event => setProfessionalProfile(current => ({ ...current, address: event.target.value }))} placeholder="Endereço do escritório" /></label>
              <label>E-mail<input type="email" value={professionalProfile.email} onChange={event => setProfessionalProfile(current => ({ ...current, email: event.target.value }))} placeholder="E-mail profissional" /></label>
            </div>
            <button type="button" className="secondary-button compact" onClick={saveProfessionalProfile}><Save size={16}/> Salvar dados do advogado</button>
          </>}
          {profileStatus && <small>{profileStatus}</small>}
        </div>
        <label>Tipo de peça
          <select value={pieceType} onChange={event => setPieceType(event.target.value)}>
            {options.map(option => <option key={option}>{option}</option>)}
          </select>
        </label>
        {!isAdmin && <div className="operation-price-line piece-operation-price">
          <span className="operation-price-main">Peça · <b>{formatBRL(pieceQuoteCents||0)}</b></span>
          <span className={walletBalanceCents < pieceQuoteCents ? 'operation-balance missing' : 'operation-balance'}>
            {walletBalanceCents < pieceQuoteCents
              ? <>Faltam <b>{formatBRL(pieceQuoteCents-walletBalanceCents)}</b></>
              : <>Saldo {formatBRL(walletBalanceCents||0)}</>}
          </span>
          {pieceQuoteError && <span className="error">{pieceQuoteError}</span>}
        </div>}
        {!isAdmin && pieceQuoteCents>0 && walletBalanceCents<pieceQuoteCents
          ? <button className="primary-button buy-required-button" type="button" onClick={onRecharge}>
              <CreditCard size={18}/> Comprar créditos
            </button>
          : <button className="primary-button" disabled={pieceBusy || (!isAdmin && pieceQuoteCents<=0)} onClick={handleGeneratePiece}>
              {pieceBusy ? pieceStage || 'Gerando rascunho...' : 'Gerar Rascunho'} <ChevronRight size={18}/>
            </button>}
        {pieceError && <p className="analysis-error" id="piece-error-box" tabIndex={-1}>{pieceError}</p>}
      </div>

      {piece && <div className="piece-review" id="piece-review">
        <div className="piece-draft-banner">
          <AlertTriangle size={20}/>
          <strong>RASCUNHO DE PEÇA PROCESSUAL — Revisão jurídica por advogado é obrigatória antes de qualquer protocolo ou utilização processual.</strong>
        </div>

        <div className="piece-review-heading">
          <div>
            <h2>{piece.title}</h2>
          </div>
          <div className="piece-actions no-print" data-ui-only="true">
            <button onClick={() => exportPieceAsWord(report, piece)}><Download size={17}/> Exportar Word</button>
            <button onClick={() => exportPieceAsPdf(report, piece)}><Download size={17}/> Exportar PDF</button>
          </div>
        </div>

        <div className="piece-validation-panel no-print" data-ui-only="true">
          <div className="validation-counts">
            <span><CheckCircle2 size={16}/> {piece.validation.confirmed} confirmadas</span>
            <span>{piece.validation.partiallyConfirmed} parcialmente confirmadas</span>
            <span>{piece.validation.unconfirmed} não confirmadas</span>
            <span>{piece.validation.corrected || 0} corrigidas</span>
            <span>{piece.validation.conflicting} conflitantes</span>
          </div>
          {(piece.validation.unconfirmed > 0 || piece.validation.conflicting > 0 || (piece.validation.corrected||0) > 0) &&
            <p>Itens “Corrigidos” representam alegações anteriores ajustadas pela peça para coincidir com o relatório/prova prevalente. “Conflitante” fica reservado para divergência que ainda permanece na peça final.</p>}
          {(() => {
            const text=piece.sections.map(section=>`${section.title} ${section.content}`).join(' ')
            const pending=Array.from(new Set((text.match(/\[(?:NÚMERO|NUMERO|CEP|RG|CPF|CNPJ|ENDEREÇO|DATA|VALOR)[^\]]*\]/gi)||[])))
            return pending.length ? <p><b>Pendências de qualificação/revisão:</b> {pending.join(' · ')}</p> : null
          })()}
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

function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!auth) return
    setError('')
    setLoading(true)
    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    } catch (err: any) {
      const code = String(err?.code || '')
      if (code.includes('email-already-in-use')) setError('Este e-mail já possui cadastro. Entre com sua senha.')
      else if (code.includes('weak-password')) setError('Use uma senha com pelo menos 6 caracteres.')
      else if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) setError('E-mail ou senha inválidos.')
      else setError('Não foi possível concluir o acesso. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }

  async function loginWithGoogle() {
    if (!auth) return
    setError('')
    setLoading(true)
    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(auth, provider)
    } catch (err: any) {
      const code = String(err?.code || '')
      if (!code.includes('popup-closed-by-user')) {
        setError(code.includes('operation-not-allowed')
          ? 'O login com Google precisa ser habilitado no Firebase Authentication.'
          : 'Não foi possível entrar com Google. Tente novamente.')
      }
    } finally {
      setLoading(false)
    }
  }

  return <div className="auth-shell">
    <div className="auth-card">
      <div className="auth-brand">
        <img className="logo-light" src="/assets/logo-processo-360-ia.svg" alt="Processo 360 IA" />
        <img className="logo-dark" src="/assets/logo-processo-360-ia-dark.svg" alt="Processo 360 IA" />
      </div>
      <span className="eyebrow"><ShieldCheck size={16}/> Acesso ao Processo 360 IA</span>
      <h1>{mode === 'login' ? 'Entrar' : 'Criar conta'}</h1>
      <p className="muted">Use e-mail e senha ou sua conta Google.</p>

      <button type="button" className="google-login-button" onClick={loginWithGoogle} disabled={loading}>
        <svg className="google-g-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M21.35 12.2c0-.7-.06-1.22-.2-1.77H12v3.34h5.37a4.58 4.58 0 0 1-1.99 3.01l-.02.11 2.9 2.25.2.02c1.84-1.7 2.89-4.2 2.89-6.96Z"/>
          <path fill="#34A853" d="M12 21.72c2.62 0 4.82-.86 6.43-2.36l-3.07-2.38c-.82.55-1.9.94-3.36.94-2.52 0-4.66-1.7-5.43-4.05l-.11.01-3.02 2.34-.04.1A9.72 9.72 0 0 0 12 21.72Z"/>
          <path fill="#FBBC05" d="M6.57 13.87A5.84 5.84 0 0 1 6.25 12c0-.65.11-1.27.3-1.87v-.12L3.5 7.64l-.1.05A9.72 9.72 0 0 0 2.28 12c0 1.56.37 3.03 1.12 4.31l3.17-2.44Z"/>
          <path fill="#EA4335" d="M12 6.08c1.82 0 3.05.78 3.75 1.43l2.74-2.68C16.81 3.27 14.62 2.28 12 2.28a9.72 9.72 0 0 0-8.6 5.41l3.15 2.44C7.34 7.78 9.48 6.08 12 6.08Z"/>
        </svg>
        <span>Entrar com Google</span>
      </button>

      <div className="auth-divider"><span>ou</span></div>

      <form onSubmit={submit}>
        <label>E-mail
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email"/>
        </label>
        <label>Senha
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} minLength={6} required autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}/>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary-button" disabled={loading}>
          {loading ? 'Aguarde...' : mode === 'login' ? 'Entrar' : 'Criar conta e entrar'}
        </button>
      </form>

      <button type="button" className="auth-switch" onClick={()=>{setMode(mode === 'login' ? 'signup' : 'login');setError('')}}>
        {mode === 'login' ? 'Ainda não tenho conta — criar cadastro' : 'Já tenho conta — entrar'}
      </button>

      <div className="auth-highlights" aria-label="Recursos do Processo 360 IA">
        <article><FileText size={20}/><div><b>Análise integral do processo</b><span>Envie o PDF e receba uma análise jurídica consolidada.</span></div></article>
        <article><BrainCircuit size={20}/><div><b>Processos extensos</b><span>Divisão automática em lotes seguros e leitura estruturada.</span></div></article>
        <article><ShieldCheck size={20}/><div><b>Rastreabilidade documental</b><span>Fatos, provas, decisões e referências organizados no relatório.</span></div></article>
        <article><FilePenLine size={20}/><div><b>Geração de peça jurídica</b><span>Rascunho a partir da análise consolidada, com validação factual.</span></div></article>
      </div>
    </div>
  </div>
}



function walletPackages(config:WalletConfig) {
  const fallback = [
    {value:4000,url:'https://payment-link-v3.ton.com.br/pl_L4oBjJNOkKyEJLGCrvCjO31nA9pG78db'},
    {value:8000,url:'https://payment-link-v3.ton.com.br/pl_4n9ELgN872OXmzD9cyT1RMvDdBbxzGaj'},
    {value:12000,url:'https://payment-link-v3.ton.com.br/pl_1wy7Jor82XxB8OEULRIqGdGALMQKzY4N'}
  ]

  const configured = [
    {value:Number(config.package1Cents||0),url:String(config.package1Url||'')},
    {value:Number(config.package2Cents||0),url:String(config.package2Url||'')},
    {value:Number(config.package3Cents||0),url:String(config.package3Url||'')}
  ].filter(item=>item.value>0 && item.url)

  return configured.length ? configured : fallback
}

const PAYMENT_PROOF_WHATSAPP_URL = 'https://wa.me/5521996157226?text=' + encodeURIComponent(
  'Olá! Acabei de realizar o pagamento de créditos do Processo 360 IA. Segue o comprovante para conferência e liberação do saldo.'
)

function BuyCreditsModal({config,balanceCents,onClose}:{config:WalletConfig;balanceCents:number;onClose:()=>void}) {
  const packages = walletPackages(config)
  return <div className="wallet-modal-backdrop" role="dialog" aria-modal="true" aria-label="Comprar créditos">
    <section className="wallet-modal">
      <button className="wallet-modal-close" type="button" onClick={onClose} aria-label="Fechar"><X size={20}/></button>
      <span className="eyebrow"><CreditCard size={16}/> Carteira pré-paga</span>
      <h2>Comprar créditos</h2>
      <p className="muted">Saldo atual: <b>{formatBRL(balanceCents)}</b></p>
      <p>Escolha o valor que deseja adicionar à sua carteira.</p>
      <div className="wallet-credit-options">
        {packages.map((item,index)=><button key={index} type="button" onClick={()=>window.open(item.url,'_blank','noopener,noreferrer')}>
          <CreditCard size={19}/>
          <span>Adicionar</span>
          <strong>{formatBRL(item.value)}</strong>
        </button>)}
      </div>
      <small className="wallet-payment-note">O pagamento é realizado em ambiente seguro do provedor de pagamentos.</small>
      <small className="wallet-payment-note"><b>Após pagar, envie o comprovante para o suporte pelo WhatsApp. O crédito é lançado manualmente em até 24 horas.</b></small>
      <button
        className="wallet-whatsapp-button"
        type="button"
        onClick={()=>window.open(PAYMENT_PROOF_WHATSAPP_URL,'_blank','noopener,noreferrer')}
      >
        Enviar comprovante para o suporte
      </button>
      {config.paymentInstructions && <small className="wallet-payment-note">{config.paymentInstructions}</small>}
    </section>
  </div>
}

function WalletFundingPanel({config,missingCents}:{config:WalletConfig;missingCents:number}) {
  const packages = walletPackages(config)

  return <div className="wallet-funding-panel">
    <p><b>Saldo insuficiente — Comprar créditos.</b> Adicione pelo menos <b>{formatBRL(Math.max(0,missingCents))}</b>.</p>
    {packages.length
      ? <div className="wallet-package-actions">{packages.map((item,index)=>
          <button key={index} type="button" onClick={()=>window.open(item.url,'_blank','noopener,noreferrer')}>
            Adicionar {formatBRL(item.value)}
          </button>)}</div>
      : <small>Os links de recarga ainda não foram configurados.</small>}
    <small>Após pagar, envie o comprovante para o suporte pelo WhatsApp. O crédito é lançado manualmente em até 24 horas.</small>
    <button
      className="wallet-whatsapp-button compact"
      type="button"
      onClick={()=>window.open(PAYMENT_PROOF_WHATSAPP_URL,'_blank','noopener,noreferrer')}
    >
      Enviar comprovante para o suporte
    </button>
    {config.paymentInstructions && <small>{config.paymentInstructions}</small>}
  </div>
}

function WalletBlockedPage({user,wallet}:{user:User;wallet:WalletRecord|null}) {
  const status = wallet?.status || 'inativo'
  return <div className="subscription-shell">
    <div className="subscription-card">
      <div className="auth-brand">
        <img className="logo-light" src="/assets/logo-processo-360-ia.svg" alt="Processo 360 IA" />
        <img className="logo-dark" src="/assets/logo-processo-360-ia-dark.svg" alt="Processo 360 IA" />
      </div>
      <span className={`subscriber-status-badge ${status}`}>{status === 'bloqueado' ? 'Acesso bloqueado' : 'Acesso inativo'}</span>
      <h1>Acesso indisponível</h1>
      <p className="muted">A conta <b>{user.email}</b> está com acesso {status}. Entre em contato com o administrador para regularização.</p>
      <button className="secondary-button" onClick={()=>auth&&signOut(auth)}>Sair da conta</button>
    </div>
  </div>
}

function WalletManager({user,onLogout,serviceDb,serviceFunctions}:{user:User;onLogout:()=>void;serviceDb:any;serviceFunctions:any}) {
  const [items,setItems]=useState<WalletRecord[]>([])
  const [filter,setFilter]=useState('')
  const [error,setError]=useState('')
  const [savingConfig,setSavingConfig]=useState(false)
  const [adjustingUid,setAdjustingUid]=useState<string|null>(null)
  const [testArmingUid,setTestArmingUid]=useState<string|null>(null)
  const [testMessage,setTestMessage]=useState('')
  const [adjustingItem,setAdjustingItem]=useState<WalletRecord|null>(null)
  const [adjustmentType,setAdjustmentType]=useState<'recarga'|'ajuste_admin'>('recarga')
  const [adjustmentDirection,setAdjustmentDirection]=useState<'credit'|'debit'>('credit')
  const [adjustmentValue,setAdjustmentValue]=useState('')
  const [adjustmentReason,setAdjustmentReason]=useState('')
  const [config,setConfig]=useState<WalletConfig>({
    analysisMinimumCostCents:0,
    analysisCostPerPageCents:0,
    pieceCostCents:0,
    marginMultiplier:3,
    package1Cents:4000,package1Url:'https://payment-link-v3.ton.com.br/pl_L4oBjJNOkKyEJLGCrvCjO31nA9pG78db',
    package2Cents:8000,package2Url:'https://payment-link-v3.ton.com.br/pl_4n9ELgN872OXmzD9cyT1RMvDdBbxzGaj',
    package3Cents:12000,package3Url:'https://payment-link-v3.ton.com.br/pl_1wy7Jor82XxB8OEULRIqGdGALMQKzY4N',
    paymentInstructions:'',
    lowBalanceWarningCents:1000,
    supportContact:''
  })

  useEffect(()=>{
    if(!serviceDb) return
    const unsubscribeWallets = onSnapshot(collection(serviceDb,'wallets'), snap=>{
      const rows=snap.docs.map(d=>({id:d.id,...d.data()} as WalletRecord))
      rows.sort((a,b)=>String(a.email||'').localeCompare(String(b.email||'')))
      setItems(rows)
    },()=>setError('Não foi possível carregar os usuários.'))

    const unsubscribeConfig = onSnapshot(doc(serviceDb,'walletConfig','main'), snap=>{
      if(snap.exists()) setConfig(prev=>({...prev,...snap.data()} as WalletConfig))
    })

    return ()=>{unsubscribeWallets();unsubscribeConfig()}
  },[])

  async function changeStatus(item:WalletRecord,status:WalletStatus){
    if(!serviceFunctions) return
    setError('')
    try{
      const call=httpsCallable(serviceFunctions,'adminSetWalletStatus')
      await call({uid:item.uid,status})
    }catch{
      setError('Não foi possível alterar o status do usuário.')
    }
  }

  function openAdjustBalance(item:WalletRecord){
    setAdjustmentType('recarga')
    setAdjustmentDirection('credit')
    setAdjustmentValue('')
    setAdjustmentReason('')
    setAdjustingItem(item)
  }

  async function confirmAdjustBalance(){
    if(!serviceFunctions || !adjustingItem) return
    const value=parseCurrencyInput(adjustmentValue)
    if(!Number.isFinite(value) || value===0){
      setError('Informe um valor válido diferente de zero. Use vírgula ou ponto como separador decimal.')
      return
    }
    const rawCents=Math.round(Math.abs(value)*100)
    const packages=[config.package1Cents,config.package2Cents,config.package3Cents]
      .map(item=>Number(item||0))
      .filter(item=>item>0)
    if(adjustmentType==='recarga' && !packages.includes(rawCents)){
      setError(`Recarga inválida. Escolha exatamente um dos pacotes: ${packages.map(formatBRL).join(', ')}.`)
      return
    }
    if(adjustmentType==='ajuste_admin' && !adjustmentReason.trim()){
      setError('A observação é obrigatória no ajuste administrativo.')
      return
    }
    const cents=adjustmentType==='recarga'
      ? rawCents
      : adjustmentDirection==='debit' ? -rawCents : rawCents
    const after=(adjustingItem.balanceCents||0)+cents
    if(after<0){
      setError('Débito não permitido: o ajuste deixaria o saldo abaixo de zero.')
      return
    }
    setAdjustingUid(adjustingItem.uid)
    setError('')
    try{
      const call=httpsCallable(serviceFunctions,'adminAdjustWallet')
      await call({
        uid:adjustingItem.uid,
        deltaCents:cents,
        reason:adjustmentReason.trim(),
        adjustmentType,
        adjustmentDirection: adjustmentType==='recarga' ? 'credit' : adjustmentDirection
      })
      setAdjustingItem(null)
      setAdjustmentValue('')
      setAdjustmentReason('')
    }catch(err:any){
      console.error(err)
      const message=String(err?.message||'')
      setError(message.includes('RECARGA_VALOR_INVALIDO')
        ? 'O valor da recarga precisa ser exatamente um dos pacotes configurados.'
        : 'Não foi possível ajustar o saldo.')
    }finally{
      setAdjustingUid(null)
    }
  }

  async function armTestFailure(item:WalletRecord){
    if(!serviceFunctions) return
    setTestArmingUid(item.uid)
    setError('')
    setTestMessage('')
    try{
      const call=httpsCallable(serviceFunctions,'adminArmTestFailure')
      await call({uid:item.uid})
      setTestMessage(`Modo de teste armado para ${item.email}: a próxima análise será cobrada e falhará imediatamente, acionando o estorno automático.`)
    }catch(err){
      console.error(err)
      setError('Não foi possível ativar o teste de estorno.')
    }finally{
      setTestArmingUid(null)
    }
  }

  async function removeWalletUser(item:WalletRecord){
    if(!serviceFunctions) return
    if(!window.confirm(`Excluir definitivamente o usuário ${item.email}? A conta de autenticação também será removida.`)) return
    try{
      const call=httpsCallable(serviceFunctions,'adminDeleteWalletUser')
      await call({uid:item.uid})
    }catch(err:any){
      console.error(err)
      setError('Não foi possível excluir o usuário.')
    }
  }

  async function saveConfig(e:FormEvent){
    e.preventDefault()
    if(!serviceDb) return
    setSavingConfig(true)
    setError('')
    try{
      await setDoc(doc(serviceDb,'walletConfig','main'),{
        ...config,
        updatedAt:serverTimestamp(),
        updatedBy:user.email
      },{merge:true})
    }catch{
      setError('Não foi possível salvar a configuração da carteira.')
    }finally{
      setSavingConfig(false)
    }
  }

  const visible=items.filter(item=>{
    const q=filter.trim().toLowerCase()
    if(!q) return true
    return String(item.email||'').toLowerCase().includes(q) || String(item.displayName||'').toLowerCase().includes(q)
  })

  const totalBalance=items.reduce((sum,item)=>sum+Math.max(0,Number(item.balanceCents||0)),0)

  return <>
    <div className="admin-header">
      <div>
        <span className="admin-badge"><Users/> Usuários e saldo</span>
        <h2>Carteira pré-paga</h2>
        <p className="muted">Todo usuário começa com saldo zero. O preço é mostrado antes do uso; o débito ocorre ao iniciar e é estornado automaticamente se a operação falhar.</p>
      </div>
      <button className="secondary-button compact" onClick={onLogout}>Sair</button>
    </div>

    <div className="subscriber-summary">
      <span><b>{items.length}</b><small>Usuários</small></span>
      <span><b>{items.filter(i=>i.status==='ativo').length}</b><small>Ativos</small></span>
      <span><b>{items.filter(i=>i.status==='bloqueado').length}</b><small>Bloqueados</small></span>
      <span><b>{formatBRL(totalBalance)}</b><small>Saldo total</small></span>
    </div>

    <form className="subscription-config-form" onSubmit={saveConfig}>
      <div className="form-title"><CreditCard size={18}/><b>Preços e recargas</b></div>
      <p className="muted">Estes valores são administrativos. O usuário verá somente o preço final da operação.</p>
      {(config.analysisMinimumCostCents<=0 || config.analysisCostPerPageCents<=0 || config.pieceCostCents<=0) &&
        <div className="admin-price-warning">Atenção: há preço zerado. Enquanto isso, o cliente verá “Serviço temporariamente indisponível”.</div>}
      <div className="wallet-formula-note">
        <b>Fórmula da análise:</b> preço final = maior valor entre (custo mínimo × margem) e (número de páginas × custo por página × margem).
        <br/>
        <span>Margem aplicada automaticamente: <b>{config.marginMultiplier||3}×</b>. Exemplo com 60 páginas: 60 × {formatBRL(config.analysisCostPerPageCents||0)} × {config.marginMultiplier||3} = {formatBRL(60*(config.analysisCostPerPageCents||0)*(config.marginMultiplier||3))}; mínimo de venda = {formatBRL((config.analysisMinimumCostCents||0)*(config.marginMultiplier||3))}.</span>
        <strong className="analysis-example-price">Preço atual do exemplo (60 páginas): {formatBRL(Math.max((config.analysisMinimumCostCents||0)*(config.marginMultiplier||3),60*(config.analysisCostPerPageCents||0)*(config.marginMultiplier||3)))}</strong>
      </div>
      <div className="admin-form-grid">
        <label>Custo mínimo da análise (centavos)
          <input type="number" min="0" value={config.analysisMinimumCostCents} onChange={e=>setConfig({...config,analysisMinimumCostCents:Number(e.target.value)||0})}/>
        </label>
        <label>Custo por página (centavos)
          <input type="number" min="0" step="0.01" value={config.analysisCostPerPageCents} onChange={e=>setConfig({...config,analysisCostPerPageCents:Number(e.target.value)||0})}/>
        </label>
      </div>
      <div className="admin-form-grid">
        <label>Custo da peça jurídica (centavos)
          <input type="number" min="0" value={config.pieceCostCents} onChange={e=>setConfig({...config,pieceCostCents:Number(e.target.value)||0})}/>
        </label>
        <label>Margem automática
          <input type="number" value={config.marginMultiplier||3} readOnly />
        </label>
      </div>
      <small>Preço fixo da peça = custo da peça × {config.marginMultiplier||3}. Preço atual: {formatBRL((config.pieceCostCents||0)*(config.marginMultiplier||3))}.</small>

      {[1,2,3].map(index=>{
        const valueKey=`package${index}Cents` as 'package1Cents'
        const urlKey=`package${index}Url` as 'package1Url'
        return <div className="admin-form-grid" key={index}>
          <label>Recarga {index} — valor (centavos)
            <input type="number" min="0" value={Number(config[valueKey]||0)} onChange={e=>setConfig({...config,[valueKey]:Number(e.target.value)||0})}/>
          </label>
          <label>Recarga {index} — link de pagamento
            <input type="url" value={String(config[urlKey]||'')} onChange={e=>setConfig({...config,[urlKey]:e.target.value})} placeholder="Deixe em branco até criar o link"/>
          </label>
        </div>
      })}
      <div className="admin-form-grid">
        <label>Aviso de saldo baixo (centavos)
          <input type="number" min="0" value={config.lowBalanceWarningCents||1000} onChange={e=>setConfig({...config,lowBalanceWarningCents:Number(e.target.value)||0})}/>
        </label>
        <label>Contato para envio do comprovante
          <input value={config.supportContact||''} onChange={e=>setConfig({...config,supportContact:e.target.value})} placeholder="WhatsApp ou e-mail"/>
        </label>
      </div>
            <label>Orientação ao usuário
        <input value={config.paymentInstructions||''} onChange={e=>setConfig({...config,paymentInstructions:e.target.value})} placeholder="Ex.: Após o pagamento, o saldo será liberado."/>
      </label>
      <button className="primary-button compact" disabled={savingConfig}><Save size={17}/>{savingConfig?'Salvando...':'Salvar configuração'}</button>
    </form>

    <div className="subscriber-toolbar">
      <label><Search size={17}/><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Buscar por nome ou e-mail"/></label>
      <span>{visible.length} usuário(s)</span>
    </div>

    {error&&<p className="error">{error}</p>}
    {testMessage&&<p className="admin-test-message">{testMessage}</p>}

    <div className="subscriber-table-wrap">
      <table className="subscriber-table">
        <thead><tr><th>Usuário</th><th>Saldo</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>
          {visible.map(item=><tr key={item.id}>
            <td><strong>{item.displayName||'—'}</strong><small>{item.email}</small></td>
            <td><strong>{formatBRL(item.balanceCents||0)}</strong></td>
            <td>
              <span className={`subscriber-status-badge ${item.status}`}>{item.status}</span>
              {item.lastStatusChangedAt && <small className="status-audit-note">
                {item.lastStatusChangedBy || 'admin'} · {item.lastStatusChangedAt?.toDate?.().toLocaleString('pt-BR') || '—'}
              </small>}
            </td>
            <td>
              <div className="subscriber-actions">
                <button className="sub-action activate" onClick={()=>changeStatus(item,'ativo')}>Ativar</button>
                <button className="sub-action deactivate" onClick={()=>changeStatus(item,'inativo')}>Desativar</button>
                <button className="sub-action block" onClick={()=>changeStatus(item,'bloqueado')}>Bloquear</button>
                <button className="sub-action" disabled={adjustingUid===item.uid} onClick={()=>openAdjustBalance(item)}>{adjustingUid===item.uid?'Ajustando...':'Ajustar saldo'}</button>
                <button className={`sub-action ${item.forceNextAnalysisFailure?'test-armed':''}`} disabled={testArmingUid===item.uid || item.forceNextAnalysisFailure===true} onClick={()=>armTestFailure(item)}>
                  {testArmingUid===item.uid ? 'Armando teste...' : item.forceNextAnalysisFailure ? 'Estorno armado ✓' : 'Testar estorno'}
                </button>
                <button className="sub-action delete" onClick={()=>removeWalletUser(item)}><Trash2 size={14}/> Apagar</button>
              </div>
            </td>
          </tr>)}
          {visible.length===0&&<tr><td colSpan={4}><div className="empty-admin"><Users/><b>Nenhum usuário encontrado</b></div></td></tr>}
        </tbody>
      </table>
    </div>

    {adjustingItem && <div className="wallet-adjust-backdrop">
      <section className="wallet-adjust-panel" role="dialog" aria-modal="true">
        <h3>Ajustar saldo</h3>
        <p><b>{adjustingItem.email}</b></p>
        <label>Tipo
          <select value={adjustmentType} onChange={e=>{setAdjustmentType(e.target.value as 'recarga'|'ajuste_admin');setAdjustmentDirection('credit');setAdjustmentValue('');setAdjustmentReason('')}}>
            <option value="recarga">Recarga</option>
            <option value="ajuste_admin">Ajuste ADM</option>
          </select>
        </label>
        {adjustmentType==='recarga'
          ? <label>Valor da recarga
              <input value={adjustmentValue} onChange={e=>setAdjustmentValue(e.target.value)} placeholder="Ex.: 40,00 ou 40.00"/>
              <small>Pacotes permitidos: {[config.package1Cents,config.package2Cents,config.package3Cents].filter(v=>Number(v)>0).map(v=>formatBRL(Number(v))).join(' · ')}</small>
            </label>
          : <>
            <label>Operação
              <select value={adjustmentDirection} onChange={e=>setAdjustmentDirection(e.target.value as 'credit'|'debit')}>
                <option value="credit">Crédito</option>
                <option value="debit">Débito</option>
              </select>
            </label>
            <label>Valor do ajuste
              <input value={adjustmentValue} onChange={e=>setAdjustmentValue(e.target.value)} placeholder="Ex.: 10,50 ou 10.50"/>
            </label>
          </>}
        <div className="wallet-adjust-preview">
          <span>Saldo atual: <b>{formatBRL(adjustingItem.balanceCents||0)}</b></span>
          <span>Saldo novo: <b>{formatBRL((adjustingItem.balanceCents||0)+(Number.isFinite(parseCurrencyInput(adjustmentValue)) ? (adjustmentType==='ajuste_admin' && adjustmentDirection==='debit' ? -Math.round(Math.abs(parseCurrencyInput(adjustmentValue))*100) : Math.round(Math.abs(parseCurrencyInput(adjustmentValue))*100)) : 0))}</b></span>
        </div>
        <label>Observação {adjustmentType==='ajuste_admin' ? '(obrigatória)' : '(opcional)'}
          <input value={adjustmentReason} onChange={e=>setAdjustmentReason(e.target.value)} placeholder={adjustmentType==='ajuste_admin' ? 'Informe o motivo do ajuste' : 'Opcional'}/>
        </label>
        <div className="form-actions">
          <button type="button" className="secondary-button compact" onClick={()=>setAdjustingItem(null)}>Cancelar</button>
          <button type="button" className="primary-button compact" disabled={adjustingUid===adjustingItem.uid} onClick={confirmAdjustBalance}>Confirmar</button>
        </div>
      </section>
    </div>}
  </>
}

function AdminModal({user,onUser,onClose,onViewAsClient}:{user:User|null;onUser:(u:User|null)=>void;onClose:()=>void;onViewAsClient:()=>void}) {
  const [section,setSection]=useState<'carteira'|'prompts'|'uso'>('carteira')
  const [password,setPassword]=useState('')
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)

  async function login(e:FormEvent) {
    e.preventDefault()
    setError('')
    if (!adminAuth) {
      setError('Configure as credenciais do Firebase para ativar o login.')
      return
    }
    setLoading(true)
    try {
      const credential=await signInWithEmailAndPassword(adminAuth,ADMIN_EMAIL,password)
      if (credential.user.email !== ADMIN_EMAIL) {
        await signOut(adminAuth)
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
    if(adminAuth?.currentUser?.email===ADMIN_EMAIL) await signOut(adminAuth)
    onUser(null)
  }

  const usingPrimaryAdminSession = Boolean(auth?.currentUser?.email===ADMIN_EMAIL && user?.uid===auth.currentUser.uid)
  const serviceDb = usingPrimaryAdminSession ? db : adminDb
  const serviceFunctions = usingPrimaryAdminSession ? functions : adminFunctions

  return <div className="modal-backdrop">
    <div className={`admin-modal ${user ? 'admin-modal-large' : ''}`}>
      <button className="modal-close" onClick={onClose} aria-label="Fechar"><X/></button>
      {user
        ? <>
            <div className="admin-section-tabs">
              <button className={section==='carteira'?'active':''} onClick={()=>setSection('carteira')}><Users size={17}/> Carteira</button>
              <button className={section==='prompts'?'active':''} onClick={()=>setSection('prompts')}><BrainCircuit size={17}/> Prompts</button>
              <button className={section==='uso'?'active':''} onClick={()=>setSection('uso')}><FileText size={17}/> Uso de IA</button>
              <button onClick={onViewAsClient}><Search size={17}/> Ver como cliente</button>
            </div>
            {section === 'carteira'
              ? <WalletManager user={user} onLogout={logout} serviceDb={serviceDb} serviceFunctions={serviceFunctions}/>
              : section === 'prompts'
                ? <PromptManager user={user} onLogout={logout} serviceDb={serviceDb}/>
                : <AIUsageManager serviceDb={serviceDb}/>}
          </>
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

function AIUsageManager({serviceDb}:{serviceDb:any}) {
  const [items,setItems]=useState<AIUsageEntry[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')

  useEffect(()=>{
    if(!serviceDb){ setLoading(false); setError('Firestore não configurado.'); return }
    const q=query(collection(serviceDb,'aiUsage'),orderBy('createdAt','desc'),limit(100))
    return onSnapshot(q,snap=>{
      setItems(snap.docs.map(d=>({id:d.id,...d.data()} as AIUsageEntry)))
      setLoading(false)
    },err=>{
      console.error(err)
      setError('Não foi possível carregar os registros de tokens.')
      setLoading(false)
    })
  },[serviceDb])

  const promptTokens=items.reduce((sum,item)=>sum+Number(item.promptTokenCount||0),0)
  const outputTokens=items.reduce((sum,item)=>sum+Number(item.candidatesTokenCount||0),0)
  const thinkingTokens=items.reduce((sum,item)=>sum+Number(item.thoughtsTokenCount||0),0)
  const totalTokens=items.reduce((sum,item)=>sum+Number(item.totalTokenCount||0),0)

  return <section className="ai-usage-admin">
    <div className="admin-header">
      <div>
        <span className="admin-badge"><BrainCircuit/> Uso de IA</span>
        <h2>Tokens registrados</h2>
        <p className="muted">Últimos 100 registros gravados pelo Gemini para análises e peças.</p>
      </div>
    </div>
    {loading ? <p>Carregando...</p> : error ? <p className="error">{error}</p> : <>
      <div className="subscriber-summary ai-usage-summary">
        <span><b>{items.length}</b><small>Registros</small></span>
        <span><b>{promptTokens.toLocaleString('pt-BR')}</b><small>Tokens de entrada</small></span>
        <span><b>{outputTokens.toLocaleString('pt-BR')}</b><small>Tokens de saída</small></span>
        <span><b>{thinkingTokens.toLocaleString('pt-BR')}</b><small>Tokens de raciocínio</small></span>
        <span><b>{totalTokens.toLocaleString('pt-BR')}</b><small>Tokens totais</small></span>
      </div>
      <div className="subscriber-table-wrap">
        <table className="subscriber-table ai-usage-table">
          <thead><tr><th>Data</th><th>Operação</th><th>Modelo</th><th>Entrada</th><th>Saída</th><th>Raciocínio</th><th>Total</th><th>Contexto</th></tr></thead>
          <tbody>
            {items.map(item=><tr key={item.id}>
              <td>{item.createdAt?.toDate?.().toLocaleString('pt-BR') || '—'}</td>
              <td>{item.operation==='analysis'?'Análise':item.operation==='piece'?'Peça':item.operation}</td>
              <td>{item.model||'—'}</td>
              <td>{Number(item.promptTokenCount||0).toLocaleString('pt-BR')}</td>
              <td>{Number(item.candidatesTokenCount||0).toLocaleString('pt-BR')}</td>
              <td>{Number(item.thoughtsTokenCount||0).toLocaleString('pt-BR')}</td>
              <td><b>{Number(item.totalTokenCount||0).toLocaleString('pt-BR')}</b></td>
              <td>{item.context||'—'}</td>
            </tr>)}
            {items.length===0&&<tr><td colSpan={8}>Nenhum registro de token encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
  </section>
}

function PromptManager({user,onLogout,serviceDb}:{user:User;onLogout:()=>void;serviceDb:any}) {
  const [items,setItems]=useState<PromptItem[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [editingId,setEditingId]=useState<string|null>(null)
  const [title,setTitle]=useState('')
  const [area,setArea]=useState<PromptArea>('Trabalhista')
  const [perspective,setPerspective]=useState('Reclamada')
  const [purpose,setPurpose]=useState(promptPurposes[0])
  const [content,setContent]=useState('')
  const [version,setVersion]=useState(1)
  const [status,setStatus]=useState<PromptStatus>('rascunho')

  useEffect(()=>{
    if(!serviceDb){
      setLoading(false)
      setError('Firestore não configurado.')
      return
    }
    const q=query(collection(serviceDb,'prompts'),orderBy('updatedAt','desc'))
    return onSnapshot(q,snap=>{
      setItems(snap.docs.map(d=>({id:d.id,...d.data()} as PromptItem)))
      setLoading(false)
    },()=>{
      setLoading(false)
      setError('Não foi possível carregar os prompts. Verifique as regras do Firestore.')
    })
  },[])

  function changeArea(next:PromptArea){
    setArea(next)
    setPerspective(promptPerspectives[next][0])
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
    setArea(item.area as PromptArea)
    setPerspective(item.perspective)
    setPurpose(item.purpose)
    setContent(item.content)
    setVersion(item.version || 1)
    setStatus(item.status || 'rascunho')
  }

  async function save(e:FormEvent){
    e.preventDefault()
    setError('')
    if(!serviceDb) return

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
      if(editingId) await updateDoc(doc(serviceDb,'prompts',editingId),payload)
      else await addDoc(collection(serviceDb,'prompts'),{...payload,createdAt:serverTimestamp(),createdBy:user.email})
      reset()
    }catch{
      setError('Não foi possível salvar. Confirme se o Firestore está criado e com as regras publicadas.')
    }
  }

  async function remove(id:string){
    if(!serviceDb || !window.confirm('Excluir este prompt?')) return
    try{
      await deleteDoc(doc(serviceDb,'prompts',id))
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
        <p className="muted">Cadastre os prompts do Motor A e do Motor B. Use Área Global / Perspectiva Global para regras comuns às peças.</p>
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
            <select value={area} onChange={e=>changeArea(e.target.value as PromptArea)}>
              {Object.keys(promptPerspectives).map(a=><option key={a}>{a}</option>)}
            </select>
          </label>
          <label>Perspectiva
            <select value={perspective} onChange={e=>setPerspective(e.target.value)}>
              {promptPerspectives[area].map(p=><option key={p}>{p}</option>)}
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
