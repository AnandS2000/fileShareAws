const express = require('express');
const AWS = require('aws-sdk');
const { check, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { log } = require('console');
const uuid = require('uuid').v4;

const app = express();
const PORT = process.env.PORT || 3000;

// AWS Configuration
AWS.config.update({
  region: 'us-east-1',
  accessKeyId: 'AKIA3FLD4522V6E6XIH5',
  secretAccessKey: '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',
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

// Register User
app.post(
  '/register',
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password is required').exists(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const params = {
      TableName: 'Users',
      Item: { email, password },
    };

    dynamoDB.put(params, (err) => {
      if (err) {
        return res.status(500).send('Server error');
      }
      res.json({ msg: 'User registered successfully!' });
    });
  }
);

// User login route
app.post(
  '/login',
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password is required').exists(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    if (email === 'sohail.pattan220@gmail.com' && password === 'Sohail@9290') {
      req.session = { email };
      res.json({ msg: 'Login successful!' });
    } else {
      return res.status(400).json({ msg: 'Invalid Credentials' });
    }
  }
);

// Middleware to check if user is logged in
function auth(req, res, next) {
  if (!req.session || !req.session.email) {
    return res.status(401).json({ msg: 'Unauthorized' });
  }
  next();
}

// File upload route
// auth,
app.post('/upload',  upload.single('file'), (req, res) => {
  const file = req.file;
  const emailAddresses = req.body.emails.split(',').map(email => email.trim());

  if (!file) {
    return res.status(400).json({ msg: 'No file uploaded' });
  }

  const fileId = uuid();
  const filePath = path.join(__dirname, 'uploads', file.filename);
  const fileContent = fs.readFileSync(filePath);
  const fileParams = {
    Bucket: 'projectso',
    Key: fileId,
    Body: fileContent,
  };

  s3.upload(fileParams, (err, data) => {
    if (err) {
      return res.status(500).send('Server error in upload s3');
    }

    // Store file info in DynamoDB
    const dbParams = {
      TableName: 'Files',
      Item: {
        fileId,
        email: 'sohail.pattan220@gmail.com',
        s3Link: data.Location,
        emailAddresses,
        downloadedBy: [],
      },
    };

    dynamoDB.put(dbParams, (err) => {
      if (err) {
        return res.status(500).send('Server error in dynamo');
      }

      // Invoke SES email sender Lambda function
      const lambdaParams = {
        FunctionName: 'sesEmailSender',
        InvocationType: 'Event',
        Payload: JSON.stringify({ emailAddresses, s3Link: `${req.protocol}://${req.get('host')}/files/${fileId}?email=` }),
        // Payload: JSON.stringify({ emailAddresses, s3Link: data.Location }),
      };

      lambda.invoke(lambdaParams, (err) => {
        if (err) {
          console.error(err);
        }
        else{
          console.log(":::: :::: :::: :::: LAMBDA :::: :::: :::: ::::");
        }
      });

      res.json({ msg: 'File uploaded and emails sent!' });
    });
  });

  fs.unlinkSync(filePath); // Remove the file from the server
});

// File download route
// app.get('/files/:fileId', auth, (req, res) => {
//   const fileId = req.params.fileId;

//   const params = {
//     TableName: 'Files',
//     Key: { fileId },
//   };

//   dynamoDB.get(params, (err, data) => {
//     if (err) {
//       return res.status(500).send('Server error');
//     }
//     if (!data.Item) {
//       return res.status(404).json({ msg: 'File not found' });
//     }

//     // Invoke File Deleter Lambda function
//     const lambdaParams = {
//       FunctionName: 'fileDeleter',
//       InvocationType: 'Event',
//       Payload: JSON.stringify({ fileId, email: req.session.email }),
//     };

//     lambda.invoke(lambdaParams, (err) => {
//       if (err) {
//         console.error(err);
//       }else{
//         console.log(":::: :::: :::: :::: FIle Delete LAMBDA :::: :::: :::: ::::");

//       }
//     });

//     res.redirect(data.Item.s3Link);
//   });
// });

// File download route
// auth,
app.get('/files/:fileId',  (req, res) => {
  const fileId = req.params.fileId;

  const params = {
    TableName: 'Files',
    Key: { fileId },
  };

  dynamoDB.get(params, (err, data) => {
    if (err) {
      return res.status(500).send('Server error');
    }
    if (!data.Item) {
      return res.status(404).json({ msg: 'File not found' });
    }

    // Mark email as having downloaded the file
    if (!data.Item.downloadedBy.includes('sohail.pattan220@gmail.com')) {
      data.Item.downloadedBy.push('sohail.pattan220@gmail.com');

      const updateParams = {
        TableName: 'Files',
        Key: { fileId },
        UpdateExpression: 'SET downloadedBy = :downloadedBy',
        ExpressionAttributeValues: {
          ':downloadedBy': data.Item.downloadedBy,
        },
      };

      dynamoDB.update(updateParams, (err) => {
        if (err) {
          console.error(err);
        }
      });
    }

    // Check if all users have downloaded the file and delete if so
    if (data.Item.downloadedBy.length === data.Item.emailAddresses.length) {
      const lambdaParams = {
        FunctionName: 'fileDeleter',
        InvocationType: 'Event',
        Payload: JSON.stringify({ fileId, bucketName: 'projectso', tableName: 'Files' }),
      };

      lambda.invoke(lambdaParams, (err, data) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ msg: 'Failed to invoke Lambda' });
        }

        console.log('Lambda function invoked for deletion');
      });
    }

    res.redirect(data.Item.s3Link);
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
