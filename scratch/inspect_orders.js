const admin = require('firebase-admin');
const serviceAccount = require('../foodman-1f911-firebase-adminsdk-fbsvc-6253adf187.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

async function inspectOrders() {
    try {
        console.log('Querying last 10 orders...');
        const snapshot = await db.collection('tot_orders').orderBy('createdAt', 'desc').limit(10).get();
        if (snapshot.empty) {
            console.log('No orders found.');
            process.exit(0);
        }
        
        snapshot.docs.forEach((doc, idx) => {
            const data = doc.data();
            console.log(`\nOrder #${idx + 1}: ID=${data.id}`);
            console.log(`  createdAt: ${data.createdAt}`);
            console.log(`  status: ${data.status}`);
            console.log(`  employeeName: ${data.employeeName}`);
            console.log(`  employeePhone: ${data.employeePhone}`);
            console.log(`  employeeId: ${data.employeeId}`);
            console.log(`  paymentMode: ${data.paymentMode}`);
            console.log(`  paymentStatus: ${data.paymentStatus}`);
            console.log(`  totalAmount: ${data.totalAmount}`);
            console.log(`  isOfflineSale: ${data.isOfflineSale}`);
            console.log(`  items: ${JSON.stringify(data.items)}`);
        });
        
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

inspectOrders();
