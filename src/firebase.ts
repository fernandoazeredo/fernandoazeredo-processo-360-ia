import { getApps, initializeApp } from 'firebase/app'
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

export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.appId)
const app = firebaseConfigured ? (getApps()[0] ?? initializeApp(firebaseConfig)) : null

export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null
export const storage = app ? getStorage(app) : null
export const functionsClient = app ? getFunctions(app, 'us-central1') : null
