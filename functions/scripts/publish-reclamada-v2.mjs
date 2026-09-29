import { readFile } from 'node:fs/promises'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const configs = [
  {
    area: 'Trabalhista',
    perspective: 'Reclamada',
    purpose: 'Análise jurídica global',
    sourceVersion: '2026-09-29-trabalhista-reclamada-v5',
    sourceFile: '01_Trabalhista_Favor_Reclamada.txt',
    title: 'Trabalhista — Reclamada — Análise jurídica global v5'
  },
  {
    area: 'Trabalhista',
    perspective: 'Reclamante',
    purpose: 'Análise jurídica global',
    sourceVersion: '2026-09-29-trabalhista-reclamante-v5',
    sourceFile: '02_Trabalhista_Favor_Reclamante.txt',
    title: 'Trabalhista — Reclamante — Análise jurídica global v5'
  }
]

for (const cfg of configs) {
  const content = (await readFile(new URL(`../prompts/${cfg.sourceFile}`, import.meta.url), 'utf8')).trim()
  const snap = await db.collection('prompts').get()
  const matching = snap.docs.filter(doc => {
    const d = doc.data()
    return d.area === cfg.area && d.perspective === cfg.perspective && d.purpose === cfg.purpose
  })

  const alreadyPublished = matching.find(doc => {
    const d = doc.data()
    return d.sourceVersion === cfg.sourceVersion && d.status === 'publicado'
  })
  if (alreadyPublished) {
    console.log(`SKIP: ${cfg.perspective} já publicado em ${alreadyPublished.id} (${cfg.sourceVersion}).`)
    continue
  }

  const maxVersion = matching.reduce((max, doc) => Math.max(max, Number(doc.data().version) || 0), 0)
  const nextVersion = Math.max(3, maxVersion + 1)
  const ordered = [...matching].sort((a, b) => (Number(b.data().version) || 0) - (Number(a.data().version) || 0))
  const target = ordered[0]
  const fallbackId = `trabalhista-${cfg.perspective.toLowerCase()}-analise-global-v3`
  const targetRef = target ? target.ref : db.collection('prompts').doc(fallbackId)

  const payload = {
    title: cfg.title,
    area: cfg.area,
    perspective: cfg.perspective,
    purpose: cfg.purpose,
    content,
    version: nextVersion,
    status: 'publicado',
    sourceFile: cfg.sourceFile,
    sourceVersion: cfg.sourceVersion,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'system-publish'
  }

  if (target) await targetRef.set(payload, { merge: true })
  else await targetRef.set({ ...payload, createdAt: FieldValue.serverTimestamp(), createdBy: 'system-publish' })

  for (const doc of matching) {
    if (doc.id === targetRef.id) continue
    if (doc.data().status === 'publicado') {
      await doc.ref.update({ status: 'inativo', updatedAt: FieldValue.serverTimestamp(), updatedBy: 'system-publish' })
    }
  }

  console.log(`PUBLICADO: ${cfg.area} / ${cfg.perspective} / ${cfg.purpose} — versão ${nextVersion} — doc ${targetRef.id}`)
}
