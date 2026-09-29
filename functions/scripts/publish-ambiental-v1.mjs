import { readFile } from 'node:fs/promises'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const configs = [
  {
    area: 'Ambiental',
    perspective: 'Autuado / Réu',
    purpose: 'Análise jurídica global',
    sourceVersion: '2026-09-29-ambiental-autuado-reu-v1',
    sourceFile: '07_Ambiental_Favor_Autuado.txt',
    title: 'Ambiental — Autuado / Réu — Análise jurídica global v1'
  },
  {
    area: 'Ambiental',
    perspective: 'Órgão Ambiental / MP',
    purpose: 'Análise jurídica global',
    sourceVersion: '2026-09-29-ambiental-orgao-mp-v1',
    sourceFile: '08_Ambiental_Favor_OrgaoAmbiental_MP.txt',
    title: 'Ambiental — Órgão Ambiental / MP — Análise jurídica global v1'
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
    console.log(`SKIP: ${cfg.area} / ${cfg.perspective} já publicado em ${alreadyPublished.id} (${cfg.sourceVersion}).`)
    continue
  }

  const maxVersion = matching.reduce((max, doc) => Math.max(max, Number(doc.data().version) || 0), 0)
  const nextVersion = Math.max(2, maxVersion + 1)
  const ordered = [...matching].sort((a, b) => (Number(b.data().version) || 0) - (Number(a.data().version) || 0))
  const target = ordered[0]
  const fallbackId = cfg.perspective === 'Autuado / Réu'
    ? 'ambiental-autuado-reu-analise-global-v1'
    : 'ambiental-orgao-mp-analise-global-v1'
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
