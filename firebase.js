import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBkieaagMrdaIA-d0HoW64kzNe-d5vXNLY",
  authDomain: "soalshean.firebaseapp.com",
  projectId: "soalshean",
  storageBucket: "soalshean.firebasestorage.app",
  messagingSenderId: "688369605656",
  appId: "1:688369605656:web:71055366521e938bc9776d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export {
  auth,
  db,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp
};

