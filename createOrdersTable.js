const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
require('dotenv').config();

const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const tableName = process.env.DYNAMODB_ORDERS_TABLE || 'Orders';

const params = {
    TableName: tableName,
    AttributeDefinitions: [
        {
            AttributeName: 'id',
            AttributeType: 'S',
        },
    ],
    KeySchema: [
        {
            AttributeName: 'id',
            KeyType: 'HASH',
        },
    ],
    BillingMode: 'PAY_PER_REQUEST',
};

async function createTable() {
    try {
        console.log(`Creating table: ${tableName}...`);
        const data = await client.send(new CreateTableCommand(params));
        console.log('Table created successfully:', data.TableDescription.TableStatus);
    } catch (err) {
        if (err.name === 'ResourceInUseException') {
            console.log(`Table ${tableName} already exists.`);
        } else {
            console.error('Error creating table:', err);
        }
    }
}

createTable();
