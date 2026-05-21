const admin = require('firebase-admin');
const serviceAccount = require('../foodman-1f911-firebase-adminsdk-fbsvc-6253adf187.json');

let db;

const initFirebase = () => {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
    }
    db = admin.firestore();
    return db;
};

const getFirestore = () => {
    if (!db) {
        return initFirebase();
    }
    return db;
};

// Expose admin for use in other modules (e.g. verifyIdToken in auth routes)
const getFirebaseAdmin = () => admin;

module.exports = { initFirebase, getFirestore, getFirebaseAdmin };
