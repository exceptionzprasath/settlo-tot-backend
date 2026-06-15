const { initFirebase } = require('./config/firebaseAdmin');
const db = initFirebase();

async function run() {
    try {
        const snapshot = await db.collection('tot_orders').orderBy('createdAt', 'desc').limit(5).get();
        console.log('Orders found:', snapshot.size);
        snapshot.forEach(doc => {
            const data = doc.data();
            console.log(`Order #${doc.id}: status=${data.status}, paymentMethod=${data.paymentMethod}, paymentMode=${data.paymentMode}, totalAmount=${data.totalAmount}`);
            console.log('JSON:', JSON.stringify(data, null, 2));
            console.log('---');
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
