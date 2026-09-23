import { getApps, initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { getAI, GoogleAIBackend } from 'firebase/ai'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getFunctions } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
}

const RECAPTCHA_ENTERPRISE_SITE_KEY =
  import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY ||
  '6Lc6ScstAAAAAIqfnEgXBICtkJtSbh6Wj7Cofwiz'

export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.appId)
const app = firebaseConfigured ? (getApps()[0] ?? initializeApp(firebaseConfig)) : null

// O App Check precisa ser inicializado antes do uso do Firebase AI Logic.
// A chave do site reCAPTCHA Enterprise é pública por definição; ela identifica
// o app Web e não substitui credenciais privadas.
if (app && typeof window !== 'undefined') {
  // Em canais de preview do Firebase Hosting, use o provedor de depuração do
  // App Check. Isso evita falhas 401 por domínio temporário do preview sem
  // reduzir a proteção do domínio oficial de produção.
  const hostname = window.location.hostname
  const isFirebasePreview =
    hostname.includes('--') &&
    (hostname.endsWith('.web.app') || hostname.endsWith('.firebaseapp.com'))

  if (isFirebasePreview) {
    ;(self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true
  }

  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    })
  } catch (error: any) {
    // Em hot reload o App Check pode já estar inicializado. Não interromper o app
    // por uma segunda tentativa de inicialização.
    if (!String(error?.code || error?.message || '').includes('already-initialized')) {
      console.warn('Processo 360 IA - App Check', error)
    }
  }
}

export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null
export const storage = app ? getStorage(app) : null
export const functionsClient = app ? getFunctions(app, 'us-central1') : null
export const aiClient = app ? getAI(app, { backend: new GoogleAIBackend() }) : null
