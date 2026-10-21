// Shared Firebase configuration and imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export * from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
export * from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBkieaagMrdaIA-d0HoW64kzNe-d5vXNLY",
  authDomain: "soalshean.firebaseapp.com",
  projectId: "soalshean",
  storageBucket: "soalshean.firebasestorage.app",
  messagingSenderId: "688369605656",
  appId: "1:688369605656:web:71055366521e938bc9776d"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
