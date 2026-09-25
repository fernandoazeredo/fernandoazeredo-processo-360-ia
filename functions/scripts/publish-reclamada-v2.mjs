import { readFile } from 'node:fs/promises'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const AREA = 'Trabalhista'
const PERSPECTIVE = 'Reclamada'
const PURPOSE = 'Análise jurídica global'
const SOURCE_VERSION = '2026-09-25-reclamada-v2'
const SOURCE_FILE = '01_Trabalhista_Favor_Reclamada.txt'

const content = (await readFile(new URL('../prompts/01_Trabalhista_Favor_Reclamada.txt', import.meta.url), 'utf8')).trim()
const title = 'Trabalhista — Reclamada — Análise jurídica global'

const snap = await db.collection('prompts').get()
const matching = snap.docs.filter(doc => {
  const d = doc.data()
  return d.area === AREA && d.perspective === PERSPECTIVE && d.purpose === PURPOSE
})

const alreadyPublished = matching.find(doc => {
  const d = doc.data()
  return d.sourceVersion === SOURCE_VERSION && d.status === 'publicado'
})

if (alreadyPublished) {
  console.log(`SKIP: prompt já publicado em ${alreadyPublished.id} (${SOURCE_VERSION}).`)
  process.exit(0)
}

const maxVersion = matching.reduce((max, doc) => Math.max(max, Number(doc.data().version) || 0), 0)
const nextVersion = Math.max(2, maxVersion + 1)

const ordered = [...matching].sort((a, b) => (Number(b.data().version) || 0) - (Number(a.data().version) || 0))
const target = ordered[0]
const targetRef = target
  ? target.ref
  : db.collection('prompts').doc('trabalhista-reclamada-analise-global-v2')

const payload = {
  title,
  area: AREA,
  perspective: PERSPECTIVE,
  purpose: PURPOSE,
  content,
  version: nextVersion,
  status: 'publicado',
  sourceFile: SOURCE_FILE,
  sourceVersion: SOURCE_VERSION,
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'system-publish'
}

if (target) {
  await targetRef.set(payload, { merge: true })
} else {
  await targetRef.set({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'system-publish'
  })
}

for (const doc of matching) {
  if (doc.id === targetRef.id) continue
  if (doc.data().status === 'publicado') {
    await doc.ref.update({
      status: 'inativo',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'system-publish'
    })
  }
}

console.log(`PUBLICADO: ${AREA} / ${PERSPECTIVE} / ${PURPOSE} — versão ${nextVersion} — doc ${targetRef.id}`)
