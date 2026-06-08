const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SNSClient } = require('@aws-sdk/client-sns');
require('dotenv').config();

const region = process.env.AWS_REGION || 'ap-south-1';
const mainCredentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

// S3 Client (for document uploads)
const s3Client = new S3Client({
    region,
    credentials: mainCredentials,
});

// DynamoDB Client (for user data)
const ddbClient = new DynamoDBClient({
    region,
    credentials: mainCredentials,
});

// DynamoDB Document Client (more convenient for JS objects)
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

// SNS Client (for sending OTP SMS)
const snsClient = new SNSClient({
    region: process.env.AWS_SNS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_SNS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SNS_SECRET_ACCESS_KEY,
    },
});

module.exports = {
    s3Client,
    ddbDocClient,
    snsClient,
    bucketName: process.env.S3_BUCKET_NAME,
    tableName: process.env.DYNAMODB_TABLE_NAME,
    ordersTable: process.env.DYNAMODB_ORDERS_TABLE || 'tot_orders',
};
