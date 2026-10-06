import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()
const ref = db.collection('walletConfig').doc('main')
const snap = await ref.get()
const current = snap.exists ? snap.data() || {} : {}

const updates = {}
if (Number(current.analysisMinimumCostCents || 0) <= 0) updates.analysisMinimumCostCents = 100
if (Number(current.analysisCostPerPageCents || 0) <= 0) updates.analysisCostPerPageCents = 10
if (Number(current.pieceCostCents || 0) <= 0) updates.pieceCostCents = 50
if (Number(current.marginMultiplier || 0) <= 0) updates.marginMultiplier = 3
if (Number(current.analysisMinimumPriceCents || 0) <= 0) updates.analysisMinimumPriceCents = 300
if (Number(current.analysisPricePerPageCents || 0) <= 0) updates.analysisPricePerPageCents = 30
if (Number(current.piecePriceCents || 0) <= 0) updates.piecePriceCents = 200
if (Number(current.usdBrlRate || 0) <= 0) updates.usdBrlRate = 5.5
if (Number(current.geminiInputUsdPerMillion || 0) <= 0) updates.geminiInputUsdPerMillion = 0.75
if (Number(current.geminiOutputUsdPerMillion || 0) <= 0) updates.geminiOutputUsdPerMillion = 3.75
if (Number(current.geminiThinkingUsdPerMillion || 0) <= 0) updates.geminiThinkingUsdPerMillion = 3.75

if (Object.keys(updates).length === 0) {
  console.log('SKIP: custos da carteira já configurados; nenhum valor foi sobrescrito.')
  process.exit(0)
}

updates.updatedAt = FieldValue.serverTimestamp()
updates.updatedBy = 'system-seed-wallet-pricing'
await ref.set(updates, { merge: true })
console.log('CONFIGURADO:', JSON.stringify(updates))
