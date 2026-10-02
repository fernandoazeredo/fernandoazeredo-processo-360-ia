import { getApps, initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { getAI, GoogleAIBackend } from 'firebase/ai'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
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
const app = firebaseConfigured ? (getApps().find(item=>item.name==='[DEFAULT]') ?? initializeApp(firebaseConfig)) : null
const adminApp = firebaseConfigured ? (getApps().find(item=>item.name==='admin-session') ?? initializeApp(firebaseConfig, 'admin-session')) : null

if (app && typeof window !== 'undefined') {
  const hostname = window.location.hostname
  const isLocalDevelopment =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'

  if (isLocalDevelopment) {
    ;(self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true
  }

  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    })
  } catch (error: any) {
    if (!String(error?.code || error?.message || '').includes('already-initialized')) {
      console.warn('Processo 360 IA - App Check', error)
    }
  }
}

export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null
export const functions = app ? getFunctions(app, 'us-central1') : null
export const aiClient = app ? getAI(app, { backend: new GoogleAIBackend() }) : null

// Sessão isolada da Área ADM: autenticar aqui nunca substitui o usuário/cliente da aplicação principal.
export const adminAuth = adminApp ? getAuth(adminApp) : null
export const adminDb = adminApp ? getFirestore(adminApp) : null
export const adminFunctions = adminApp ? getFunctions(adminApp, 'us-central1') : null
