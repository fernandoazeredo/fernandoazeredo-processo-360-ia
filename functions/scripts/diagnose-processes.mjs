import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const snap = await db.collection('processos').orderBy('updatedAt', 'desc').limit(8).get()
for (const doc of snap.docs) {
  const d = doc.data()
  console.log(JSON.stringify({
    id: doc.id,
    status: d.status ?? null,
    stage: d.stage ?? null,
    progress: d.progress ?? null,
    currentLot: d.currentLot ?? null,
    openaiStatus: d.openaiStatus ?? null,
    error: d.error ?? null,
    model: d.model ?? null,
    promptCount: d.promptCount ?? null,
    processedLots: d.processedLots ?? null
  }))
}
