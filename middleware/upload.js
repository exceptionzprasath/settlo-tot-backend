const multer = require('multer');
const multerS3 = require('multer-s3');
const { s3Client, bucketName } = require('../config/awsConfig');
const path = require('path');

const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: bucketName,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const extension = path.extname(file.originalname);
            const fileName = `${file.fieldname}-${Date.now()}${extension}`;
            const folder = 'user-documents';
            cb(null, `${folder}/${fileName}`);
        }
    })
});

module.exports = upload;
