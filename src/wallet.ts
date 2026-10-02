import { PDFDocument } from 'pdf-lib'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

export type WalletStatus = 'ativo' | 'inativo' | 'bloqueado'

export type WalletRecord = {
  id: string
  uid: string
  email: string
  displayName?: string
  status: WalletStatus
  balanceCents: number
  createdAt?: any
  updatedAt?: any
  forceNextAnalysisFailure?: boolean
  lastStatusChangedAt?: any
  lastStatusChangedBy?: string
  lastStatusFrom?: WalletStatus
  lastStatusTo?: WalletStatus
}

export type WalletQuote = {
  pageCount: number
  priceCents: number
}

async function validatePdfBeforeCharge(file: File): Promise<number> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const loadingTask = getDocument({ data: bytes })
    const pdf = await loadingTask.promise
    const pageCount = pdf.numPages
    if (pageCount < 1) throw new Error('PDF_NO_READABLE_CONTENT')

    const maxChecks = Math.min(pageCount, 12)
    const pageNumbers = Array.from({length:maxChecks},(_,i)=>
      maxChecks===1 ? 1 : Math.max(1,Math.min(pageCount,Math.round(1 + (i*(pageCount-1))/(maxChecks-1))))
    )
    const uniquePages = [...new Set(pageNumbers)]

    for (const pageNumber of uniquePages) {
      const page = await pdf.getPage(pageNumber)
      const text = await page.getTextContent()
      const readable = text.items
        .map((item:any)=>String(item?.str||'').trim())
        .join(' ')
        .replace(/\s+/g,' ')
        .trim()
      if (readable.length >= 3) {
        await pdf.destroy()
        return pageCount
      }
    }

    await pdf.destroy()
    throw new Error('PDF_NO_READABLE_CONTENT')
  } catch (error:any) {
    if (String(error?.message || '').includes('PDF_NO_READABLE_CONTENT')) throw error
    throw new Error('PDF_INVALID_OR_UNREADABLE')
  }
}

function requireFunctions() {
  if (!functions) throw new Error('FIREBASE_FUNCTIONS_NOT_READY')
  return functions
}

export async function quoteAnalysis(file: File): Promise<WalletQuote> {
  const pageCount = await validatePdfBeforeCharge(file)

  const call = httpsCallable(requireFunctions(), 'walletQuoteAnalysis')
  const result = await call({ pageCount })
  const data = result.data as any

  return {
    pageCount,
    priceCents: Math.max(0, Number(data?.priceCents || 0))
  }
}

export async function quotePiece(): Promise<{ priceCents: number }> {
  const call = httpsCallable(requireFunctions(), 'walletQuotePiece')
  const result = await call({})
  const data = result.data as any

  return {
    priceCents: Math.max(0, Number(data?.priceCents || 0))
  }
}

export async function chargeAnalysis(pageCount: number, fileName?: string, expectedPriceCents?: number): Promise<{ chargeId: string; priceCents: number; balanceCents: number }> {
  const call = httpsCallable(requireFunctions(), 'walletChargeAnalysis')
  const result = await call({ pageCount, fileName: fileName || '', expectedPriceCents: Number(expectedPriceCents || 0) })
  const data = result.data as any

  return {
    chargeId: String(data?.chargeId || ''),
    priceCents: Number(data?.priceCents || 0),
    balanceCents: Number(data?.balanceCents || 0)
  }
}

export async function chargePiece(pieceType?: string, processNumber?: string, expectedPriceCents?: number): Promise<{ chargeId: string; priceCents: number; balanceCents: number }> {
  const call = httpsCallable(requireFunctions(), 'walletChargePiece')
  const result = await call({ pieceType: pieceType || '', processNumber: processNumber || '', expectedPriceCents: Number(expectedPriceCents || 0) })
  const data = result.data as any

  return {
    chargeId: String(data?.chargeId || ''),
    priceCents: Number(data?.priceCents || 0),
    balanceCents: Number(data?.balanceCents || 0)
  }
}

export async function consumeForcedAnalysisFailure(): Promise<boolean> {
  const call = httpsCallable(requireFunctions(), 'walletConsumeTestFailure')
  const result = await call({})
  return Boolean((result.data as any)?.forceFailure)
}

export async function refundCharge(chargeId: string, reason: string): Promise<{ refunded: boolean; alreadyRefunded: boolean; balanceCents: number; refundId: string }> {
  const call = httpsCallable(requireFunctions(), 'walletRefundCharge')
  const result = await call({ chargeId, reason })
  const data = result.data as any
  return {
    refunded: Boolean(data?.refunded),
    alreadyRefunded: Boolean(data?.alreadyRefunded),
    balanceCents: Number(data?.balanceCents || 0),
    refundId: String(data?.refundId || '')
  }
}

export function formatBRL(cents: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number(cents) || 0) / 100)
}
