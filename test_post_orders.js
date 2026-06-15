const axios = require('axios');
const { spawn } = require('child_process');

async function main() {
    console.log('Starting backend server on port 3002...');
    const env = { ...process.env, PORT: '3002' };
    const serverProcess = spawn('node', ['server.js'], { env, cwd: __dirname });

    serverProcess.stdout.on('data', (data) => {
        console.log(`[Server STDOUT] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
        console.error(`[Server STDERR] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
        console.error('Failed to start server process:', err);
    });

    serverProcess.on('exit', (code, signal) => {
        console.log(`Server process exited with code ${code} and signal ${signal}`);
    });

    // Wait 4 seconds for server to start
    await new Promise((resolve) => setTimeout(resolve, 4000));

    try {
        console.log('Sending mock COD order POST request...');
        const orderData = {
            id: 'ORD_TEST_' + Math.floor(100000 + Math.random() * 900000),
            items: [
                {
                    id: 'item_001',
                    name: 'Premium Tea',
                    price: 15,
                    quantity: 2
                }
            ],
            totalAmount: 30,
            deliveryAddress: 'Test Address, Chennai, Tamil Nadu',
            locationCoords: {
                latitude: 13.0827,
                longitude: 80.2707
            },
            customerName: 'Test Customer',
            customerPhone: '9999999999',
            paymentMethod: 'COD'
        };

        const response = await axios.post('http://localhost:3002/api/orders', orderData);
        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(response.data, null, 2));
    } catch (err) {
        console.error('Request failed!');
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Data:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error Details:', err);
        }
    } finally {
        console.log('Killing backend server...');
        serverProcess.kill();
    }
}

main();
