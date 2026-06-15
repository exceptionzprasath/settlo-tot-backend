const { initFirebase } = require('./config/firebaseAdmin');
const db = initFirebase();
const ordersCol = db.collection('tot_orders');

async function run() {
    console.log('Querying all orders in tot_orders...');
    const snapshot = await ordersCol.get();
    console.log(`Total orders found: ${snapshot.size}`);

    let invalidCount = 0;
    snapshot.forEach(doc => {
        const data = doc.data();
        const createdAt = data.createdAt;
        if (!createdAt) {
            console.log(`Order #${doc.id}: Missing createdAt! data:`, JSON.stringify(data));
            invalidCount++;
            return;
        }

        const date = new Date(createdAt);
        if (isNaN(date.getTime())) {
            console.log(`Order #${doc.id}: Invalid createdAt value: "${createdAt}" (type: ${typeof createdAt})`);
            invalidCount++;
        }
    });

    console.log(`Total invalid orders: ${invalidCount}`);
    process.exit(0);
}

run();
