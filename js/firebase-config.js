/* ==========================================================================
   GeoFinance System — Configuration Firebase
   ⚠️  REMPLIR avec la config de TON projet Firebase AVANT de déployer.
   Obtenir ces valeurs : console.firebase.google.com → Ton projet → ⚙️ → Paramètres du projet → Vos applications → SDK Firebase
   ========================================================================== */

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyA6QaYJxBetl5GSV2G3c_MFHQh8UyI4edI",
  authDomain: "geofinance-27dec.firebaseapp.com",
  projectId: "geofinance-27dec",
  storageBucket: "geofinance-27dec.firebasestorage.app",
  messagingSenderId: "932195662826",
  appId: "1:932195662826:web:d6cf9d0c0b26ecc33b9093"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

/* ---------- Règles Firestore à copier dans la console Firebase ----------
   Console Firebase → Firestore → Règles → Coller ceci :

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Chaque utilisateur ne peut lire/écrire QUE ses propres données
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}

---------------------------------------------------------------------------- */
