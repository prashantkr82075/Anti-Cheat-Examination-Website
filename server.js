const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory storage (in production, use a database)
const sessions = new Map();
const violationLogs = [];

// API Endpoints

// 1. Create exam session
app.post('/api/session/create', (req, res) => {
    const { studentId, examId, studentName } = req.body;
    
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const sessionData = {
        sessionId,
        studentId,
        studentName,
        examId,
        startTime: new Date().toISOString(),
        violations: 0,
        status: 'active',
        lastActivity: new Date().toISOString()
    };
    
    sessions.set(sessionId, sessionData);
    
    // Log session creation
    logToFile('sessions', sessionData);
    
    res.json({
        success: true,
        sessionId,
        message: 'Session created successfully'
    });
});

// 2. Log violation
app.post('/api/violation/log', (req, res) => {
    const violationData = req.body;
    
    // Add timestamp if not present
    if (!violationData.timestamp) {
        violationData.timestamp = new Date().toISOString();
    }
    
    // Update session violation count
    if (violationData.sessionId && sessions.has(violationData.sessionId)) {
        const session = sessions.get(violationData.sessionId);
        session.violations += 1;
        session.lastViolation = violationData.timestamp;
        session.lastActivity = new Date().toISOString();
        
        // Auto-terminate if too many violations
        if (session.violations >= 5) {
            session.status = 'terminated';
            session.endTime = new Date().toISOString();
            
            // Notify admin (in real app, send email/notification)
            notifyAdmin({
                type: 'exam_terminated',
                sessionId: session.sessionId,
                studentId: session.studentId,
                violations: session.violations
            });
        }
    }
    
    // Store violation
    violationLogs.push(violationData);
    
    // Log to file
    logToFile('violations', violationData);
    
    res.json({
        success: true,
        message: 'Violation logged successfully'
    });
});

// 3. Get session status
app.get('/api/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        res.json({
            success: true,
            session
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'Session not found'
        });
    }
});

// 4. End session
app.post('/api/session/:sessionId/end', (req, res) => {
    const { sessionId } = req.params;
    const { reason } = req.body;
    
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.status = 'ended';
        session.endTime = new Date().toISOString();
        session.endReason = reason || 'manual';
        
        // Generate report
        const report = generateReport(sessionId);
        
        res.json({
            success: true,
            message: 'Session ended successfully',
            report
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'Session not found'
        });
    }
});

// 5. Get violation logs (admin only)
app.get('/api/admin/violations', (req, res) => {
    const { startDate, endDate, studentId } = req.query;
    
    let filteredLogs = violationLogs;
    
    if (startDate) {
        filteredLogs = filteredLogs.filter(log => 
            new Date(log.timestamp) >= new Date(startDate)
        );
    }
    
    if (endDate) {
        filteredLogs = filteredLogs.filter(log => 
            new Date(log.timestamp) <= new Date(endDate)
        );
    }
    
    if (studentId) {
        filteredLogs = filteredLogs.filter(log => 
            log.studentId === studentId
        );
    }
    
    res.json({
        success: true,
        count: filteredLogs.length,
        violations: filteredLogs
    });
});

// 6. Real-time monitoring endpoint (SSE)
app.get('/api/monitor/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    // Send heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
        res.write('data: {"type": "heartbeat"}\n\n');
    }, 30000);
    
    // Store client connection
    const clientId = Date.now();
    connectedClients.set(clientId, res);
    
    // Send initial data
    const activeSessions = Array.from(sessions.values())
        .filter(s => s.status === 'active');
    
    res.write(`data: ${JSON.stringify({
        type: 'init',
        activeSessions: activeSessions.length,
        totalViolations: violationLogs.length
    })}\n\n`);
    
    // Cleanup on close
    req.on('close', () => {
        clearInterval(heartbeat);
        connectedClients.delete(clientId);
    });
});

// 7. Dashboard statistics
app.get('/api/dashboard/stats', (req, res) => {
    const activeSessions = Array.from(sessions.values())
        .filter(s => s.status === 'active');
    
    const terminatedSessions = Array.from(sessions.values())
        .filter(s => s.status === 'terminated');
    
    const recentViolations = violationLogs
        .slice(-10)
        .reverse();
    
    res.json({
        success: true,
        stats: {
            totalSessions: sessions.size,
            activeSessions: activeSessions.length,
            terminatedSessions: terminatedSessions.length,
            totalViolations: violationLogs.length,
            recentViolations
        }
    });
});

// Helper functions
function logToFile(type, data) {
    const logDir = path.join(__dirname, 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    const filename = path.join(logDir, `${type}_${new Date().toISOString().split('T')[0]}.json`);
    const logEntry = {
        timestamp: new Date().toISOString(),
        ...data
    };
    
    let logs = [];
    
    // Read existing logs
    if (fs.existsSync(filename)) {
        const content = fs.readFileSync(filename, 'utf8');
        try {
            logs = JSON.parse(content);
        } catch (e) {
            logs = [];
        }
    }
    
    // Add new log entry
    logs.push(logEntry);
    
    // Write back to file
    fs.writeFileSync(filename, JSON.stringify(logs, null, 2));
}

function generateReport(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    
    const sessionViolations = violationLogs.filter(
        log => log.sessionId === sessionId
    );
    
    return {
        sessionId,
        studentId: session.studentId,
        startTime: session.startTime,
        endTime: session.endTime || new Date().toISOString(),
        duration: calculateDuration(session.startTime, session.endTime),
        totalViolations: session.violations,
        status: session.status,
        violations: sessionViolations,
        riskLevel: calculateRiskLevel(session.violations)
    };
}

function calculateDuration(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end || new Date());
    const diffMs = endDate - startDate;
    
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    return `${hours}h ${minutes}m ${seconds}s`;
}

function calculateRiskLevel(violations) {
    if (violations === 0) return 'low';
    if (violations <= 2) return 'medium';
    if (violations <= 4) return 'high';
    return 'critical';
}

function notifyAdmin(notification) {
    // In production, implement email/SMS/WebSocket notifications
    console.log('ADMIN NOTIFICATION:', notification);
    
    // Broadcast to connected monitoring clients
    connectedClients.forEach(client => {
        client.write(`data: ${JSON.stringify({
            type: 'notification',
            ...notification
        })}\n\n`);
    });
}

// Store connected clients for real-time updates
const connectedClients = new Map();

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`API documentation available at http://localhost:${PORT}/api-docs`);
});