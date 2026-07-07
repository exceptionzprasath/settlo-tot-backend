const { ddbDocClient } = require('./config/awsConfig');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');

async function run() {
    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: 'Users',
            Key: { phone: '+910000000020' }
        }));
        console.log('Record from DB:', JSON.stringify(result.Item, null, 2));
    } catch (e) {
        console.error(e);
    }
}
run();
