import { Client, Databases } from 'node-appwrite';

// This Appwrite function will be executed every time your function is triggered
export default async ({ req, res, log, error }) => {
  // You can use the Appwrite SDK to interact with other services
  // For this example, we're using the Databases service for session storage
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');
  const databases = new Databases(client);

  const databaseId = process.env.VOICEBED_DATABASE_ID || 'voicebed';
  const sessionsCollectionId = process.env.VOICEBED_SESSIONS_COLLECTION || 'sessions';

  try {
    const path = req.path;
    const method = req.method;

    if (method === 'GET' && path === '/ping') {
      return res.text('Pong');
    }

    if (method === 'POST' && path === '/browser') {
      // Handle browser messages (simulate WebSocket)
      const body = JSON.parse(req.body || '{}');
      log('Browser message received', body);

      // Store message in database for Realtime
      const sessionCode = body.sessionCode || 'default';
      await databases.createDocument(databaseId, sessionsCollectionId, 'unique()', {
        type: 'browser_message',
        sessionCode,
        message: body,
        timestamp: new Date().toISOString(),
      });

      return res.json({ status: 'received', message: body });
    }

    if (method === 'POST' && path === '/plugin') {
      // Handle plugin messages
      const body = JSON.parse(req.body || '{}');
      log('Plugin message received', body);

      // Store message in database
      const sessionCode = body.sessionCode || 'default';
      await databases.createDocument(databaseId, sessionsCollectionId, 'unique()', {
        type: 'plugin_message',
        sessionCode,
        message: body,
        timestamp: new Date().toISOString(),
      });

      return res.json({ status: 'received', message: body });
    }

    // Default response
    return res.json({
      motto: "Build like a team of hundreds_",
      learn: "https://appwrite.io/docs",
      connect: "https://appwrite.io/discord",
      getInspired: "https://builtwith.appwrite.io",
    });
  } catch (err) {
    error("Error: " + err.message);
    return res.json({ error: err.message }, 500);
  }
};
