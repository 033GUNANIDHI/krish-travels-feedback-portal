# Krish Travels Feedback Portal

## Requirements
- Node.js 20+
- MongoDB Community Server running locally, with MongoDB Compass available to inspect data

## Setup
1. Open a terminal in this project folder.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env`.
4. Set `JWT_SECRET` to a long random secret (32+ characters), and set a strong `ADMIN_PASSWORD` (10+ characters).
5. Start MongoDB Community Server. The default connection is `mongodb://localhost:27017/`.
6. Start the portal: `npm start`
7. Open `http://localhost:3000`. The first run creates the admin account from `.env`. The admin must change the password after first login.

## View data in MongoDB Compass
Connect to `mongodb://localhost:27017/`, then open database `krish_travels_feedback`. Collections: `users`, `complaints`, `audit`.

## Roles
- Passenger: public feedback submission.
- Staff: login, weekly/dashboard metrics, complaint search and status/priority/assignment updates.
- Admin: all staff capabilities, create/disable staff accounts, reset staff passwords, audit log, CSV export.

Staff account creation and password changes require admin access. Staff passwords are hashed with bcrypt. Session cookies are HttpOnly and SameSite=Strict.

## Notes
- Keep `.env` private and never commit it.
- This project uses MongoDB as its source of truth; it no longer writes application records to `data/db.json`.
- Reports (Staff + Admin): Reports tab → Day-wise (30 days), Weekly (12 weeks), Monthly (12 months). Export: PDF (browser Print → Save as PDF), Excel (.xls, opens in Excel), CSV.
- Staff can register complaints themselves (Complaints → Register complaint); these are tagged "Staff entry" and appear next to passenger complaints. Overview shows weekly top complaint categories.
- Branding: put `logo.png` and `bus.jpg` in `public/images/`. They are picked up automatically; if missing, the text logo / CSS bus stays.
- (old note) The ZIP did not include the separately mentioned Krish bus photo or logo image files, so the existing text branding remains until those image assets are supplied.
