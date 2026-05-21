const admin = require('firebase-admin');
const path = require('path');

let db;

/**
 * Gets Firebase service account credentials.
 * - On Vercel: reads from FIREBASE_SERVICE_ACCOUNT env variable (JSON string)
 * - Locally: reads from the JSON file in the project root
 */
const getServiceAccount = () => {
    // Option 1: Environment variable (for Vercel / production)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (err) {
            console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env variable:', err.message);
            throw err;
        }
    }

    // Option 2: Local JSON file (for development)
    try {
        return require('../foodman-1f911-firebase-adminsdk-fbsvc-6253adf187.json');
    } catch (err) {
        console.error(
            'Firebase service account not found!\n' +
            'Set FIREBASE_SERVICE_ACCOUNT env variable or place the JSON file locally.\n'
        );
        throw err;
    }
};

const initFirebase = () => {
    if (!admin.apps.length) {
        const serviceAccount = getServiceAccount();
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
