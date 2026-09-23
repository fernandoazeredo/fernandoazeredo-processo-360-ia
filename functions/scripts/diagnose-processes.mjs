import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const snap = await db.collection('processos').orderBy('updatedAt', 'desc').limit(12).get()
for (const doc of snap.docs) {
  const d = doc.data()
  const lotsSnap = await doc.ref.collection('lotes').orderBy('lotNumber', 'asc').get()
  const lots = lotsSnap.docs.map(lotDoc => {
    const lot = lotDoc.data()
    return {
      id: lotDoc.id,
      lotNumber: lot.lotNumber ?? null,
      status: lot.status ?? null,
      pages: lot.pages ?? null,
      responseId: lot.responseId ?? null,
      completedAt: lot.completedAt?.toDate?.()?.toISOString?.() ?? null
    }
  })

  console.log(JSON.stringify({
    id: doc.id,
    fileName: d.fileName ?? null,
    area: d.area ?? null,
    perspective: d.perspective ?? null,
    status: d.status ?? null,
    stage: d.stage ?? null,
    progress: d.progress ?? null,
    currentLot: d.currentLot ?? null,
    completedLots: d.completedLots ?? null,
    lotCount: d.lotCount ?? null,
    resumeAvailable: d.resumeAvailable ?? null,
    openaiStatus: d.openaiStatus ?? null,
    error: d.error ?? null,
    model: d.model ?? null,
    promptCount: d.promptCount ?? null,
    processedLots: d.processedLots ?? null,
    savedLotsCount: lots.length,
    savedLots: lots,
    finalReasoningEffort: d.finalReasoningEffort ?? null,
    openaiTimings: d.openaiTimings ?? [],
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    completedAt: d.completedAt?.toDate?.()?.toISOString?.() ?? null
  }))
}
