const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors());

// តភ្ជាប់ជាមួយ PostgreSQL ដោយប្រើ DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_h4wdVLuYv2UB@ep-quiet-heart-b5ugzo5b-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ssl: { rejectUnauthorized: false }
});

// បង្កើត Table សម្រាប់រក្សាទុកប្រវត្តិការ Download (បើមិនទាន់មាន)
pool.query(`
    CREATE TABLE IF NOT EXISTS download_history (
        id SERIAL PRIMARY KEY,
        video_url TEXT NOT NULL,
        video_title TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).then(() => {
    console.log("✅ Database table 'download_history' is ready.");
}).catch(err => {
    console.error("❌ Error creating table:", err);
});

// បង្ហាញ Frontend ពី Folder public
app.use(express.static(path.join(__dirname, 'public')));

// API សម្រាប់កត់ត្រាប្រវត្តិ និងបញ្ជូន Link ទាញយកប្រកបដោយស្ថេរភាព
app.get('/download', async (req, res) => {
    try {
        const videoURL = req.query.url;

        if (!videoURL || (!videoURL.includes('youtube.com') && !videoURL.includes('youtu.be'))) {
            return res.status(400).json({ success: false, error: 'តំណភ្ជាប់ YouTube មិនត្រឹមត្រូវទេ!' });
        }

        // ចុះឈ្មោះប្រវត្តិចូលក្នុង Neon PostgreSQL Database
        const dummyTitle = "YouTube Video (" + new Date().toLocaleDateString('km-KH') + ")";
        await pool.query(
            'INSERT INTO download_history (video_url, video_title) VALUES ($1, $2)',
            [videoURL, dummyTitle]
        );

        // ส่ง URL ទៅកាន់ Frontend សម្រាប់ Redirect ទាញយកវីដេអូដោយសុវត្ថិភាព
        res.json({ 
            success: true, 
            redirectUrl: `https://en.savefrom.net/1-youtube-downloader-7/?url=${encodeURIComponent(videoURL)}` 
        });

    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).json({ success: false, error: 'មានបញ្ហាក្នុងការទាញយកវីដេអូ!' });
    }
});

// API មើលប្រវត្តិការ Download ទាំងអស់ពី Database
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM download_history ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error("Error fetching history:", err);
        res.status(500).json({ success: false, error: 'មិនអាចទាញទិន្នន័យប្រវត្តិបានទេ' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YouTube Downloader Server is running on port ${PORT}`);
});
