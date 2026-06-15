const { initFirebase } = require('./config/firebaseAdmin');
const db = initFirebase();
const ordersCol = db.collection('tot_orders');

async function run() {
    const snapshot = await ordersCol.where('customerPhone', '!=', 'N/A').limit(5).get();
    console.log(`Found ${snapshot.size} customer orders`);
    snapshot.forEach(doc => {
        const data = doc.data();
        console.log(`Order #${doc.id}: customerPhone=${data.customerPhone}, typeof Phone=${typeof data.customerPhone}, createdAt=${data.createdAt}, typeof createdAt=${typeof data.createdAt}`);
    });
    process.exit(0);
}

run();
