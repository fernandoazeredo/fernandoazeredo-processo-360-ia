import { PDFDocument } from 'pdf-lib'
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
}

export type WalletQuote = {
  pageCount: number
  priceCents: number
}

function requireFunctions() {
  if (!functions) throw new Error('FIREBASE_FUNCTIONS_NOT_READY')
  return functions
}

export async function quoteAnalysis(file: File): Promise<WalletQuote> {
  const bytes = await file.arrayBuffer()
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pageCount = pdf.getPageCount()

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

export async function chargeAnalysis(pageCount: number, fileName?: string): Promise<{ chargeId: string; priceCents: number; balanceCents: number }> {
  const call = httpsCallable(requireFunctions(), 'walletChargeAnalysis')
  const result = await call({ pageCount, fileName: fileName || '' })
  const data = result.data as any

  return {
    chargeId: String(data?.chargeId || ''),
    priceCents: Number(data?.priceCents || 0),
    balanceCents: Number(data?.balanceCents || 0)
  }
}

export async function chargePiece(pieceType?: string, processNumber?: string): Promise<{ chargeId: string; priceCents: number; balanceCents: number }> {
  const call = httpsCallable(requireFunctions(), 'walletChargePiece')
  const result = await call({ pieceType: pieceType || '', processNumber: processNumber || '' })
  const data = result.data as any

  return {
    chargeId: String(data?.chargeId || ''),
    priceCents: Number(data?.priceCents || 0),
    balanceCents: Number(data?.balanceCents || 0)
  }
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
