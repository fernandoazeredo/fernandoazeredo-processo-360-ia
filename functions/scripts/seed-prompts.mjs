import { readFile } from 'node:fs/promises'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const definitions = [
  ['01_Trabalhista_Favor_Reclamada.txt','Trabalhista','Reclamada'],
  ['02_Trabalhista_Favor_Reclamante.txt','Trabalhista','Reclamante'],
  ['03_Civel_Favor_Reu.txt','Cível','Réu'],
  ['04_Civel_Favor_Autor.txt','Cível','Autor'],
  ['05_Criminal_Favor_Defesa.txt','Criminal','Defesa'],
  ['06_Criminal_Favor_Acusacao.txt','Criminal','Acusação'],
  ['06B_Criminal_Favor_AssistenteAcusacao.txt','Criminal','Assistente de acusação'],
  ['06C_Criminal_Favor_Querelante.txt','Criminal','Querelante'],
  ['07_Ambiental_Favor_Autuado.txt','Ambiental','Autuado / Réu'],
  ['08_Ambiental_Favor_OrgaoAmbiental_MP.txt','Ambiental','Órgão Ambiental / MP'],
  ['09_Tributario_Favor_Contribuinte.txt','Tributário','Contribuinte'],
  ['10_Tributario_Favor_FazendaPublica.txt','Tributário','Fazenda Pública'],
  ['11_Administrativo_Favor_Administrado.txt','Administrativo','Administrado'],
  ['12_Administrativo_Favor_AdministracaoPublica.txt','Administrativo','Administração Pública'],
  ['13_Previdenciario_Favor_Segurado.txt','Previdenciário','Segurado'],
  ['14_Previdenciario_Favor_INSS.txt','Previdenciário','INSS'],
  ['15_Consumidor_Favor_Consumidor.txt','Consumidor','Consumidor'],
  ['16_Consumidor_Favor_Fornecedor.txt','Consumidor','Fornecedor / Empresa'],
  ['17_Familia_Favor_Requerente.txt','Família','Requerente'],
  ['18_Familia_Favor_Requerido.txt','Família','Requerido'],
  ['19_Empresarial_Favor_ParteAutora.txt','Empresarial','Parte Autora'],
  ['20_Empresarial_Favor_ParteRe.txt','Empresarial','Parte Ré']
]

const current = await db.collection('prompts').get()
const publishedKeys = new Set(
  current.docs
    .map(d => d.data())
    .filter(d => d.status === 'publicado')
    .map(d => `${d.area}|||${d.perspective}|||${d.purpose}`)
)

let created = 0
let skipped = 0

for (const [fileName, area, perspective] of definitions) {
  const key = `${area}|||${perspective}|||Análise jurídica global`
  if (publishedKeys.has(key)) {
    console.log(`SKIP ${area} / ${perspective}: já existe prompt publicado.`)
    skipped++
    continue
  }

  const content = (await readFile(new URL(`../prompts/${fileName}`, import.meta.url), 'utf8')).trim()
  const title = content.split(/\r?\n/, 1)[0].replace(/^ÁREA:\s*/,'').replace(/\s+—\s+PERSPECTIVA:\s+/,' — ')
  const id = fileName.replace(/\.txt$/,'').toLowerCase().replace(/_/g,'-')

  await db.collection('prompts').doc(id).set({
    title,
    area,
    perspective,
    purpose: 'Análise jurídica global',
    content,
    version: 1,
    status: 'publicado',
    sourceFile: fileName,
    sourceVersion: '2026-09-22',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: 'system-seed',
    updatedBy: 'system-seed'
  })

  publishedKeys.add(key)
  created++
  console.log(`CREATE ${area} / ${perspective}`)
}

console.log(`Seed concluído: ${created} criados, ${skipped} já existentes.`)
