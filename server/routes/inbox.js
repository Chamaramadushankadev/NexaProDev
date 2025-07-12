import express from 'express';
import mongoose from 'mongoose';
import { InboxMessage, EmailAccount } from '../models/ColdEmailSystemIndex.js';
import { authenticate } from '../middleware/auth.js';
import { syncInbox, sendEmail } from '../services/emailService.js';

const router = express.Router();

// Helper function to transform data
const transformMessage = (message) => {
  const messageObj = message.toObject();
  return {
    ...messageObj,
    id: messageObj._id.toString(),
    userId: messageObj.userId.toString(),
    emailAccountId: messageObj.emailAccountId.toString(),
    campaignId: messageObj.campaignId?.toString(),
    leadId: messageObj.leadId?.toString()
  };
};

// Get inbox messages
router.get('/', authenticate, async (req, res) => {
  try {
    console.log('📬 Fetching inbox messages for user:', req.user.email || req.user._id);
    const { accountId, isRead, search, page = 1, limit = 50, excludeWarmup = true } = req.query;
    const filter = { userId: req.user._id };

    if (accountId && accountId !== 'all') filter.emailAccountId = accountId;
    if (isRead === 'true') filter.isRead = true;
    if (isRead === 'false') filter.isRead = false;
    
    // Exclude warmup emails if requested
    if (excludeWarmup === 'true' || excludeWarmup === true) {
      filter.isWarmup = { $ne: true };
      // Also exclude emails with warmup-related subjects
      filter.subject = { $not: /warmup|check-in|quick question|following up/i };
    }

    console.log('📬 Inbox filter:', JSON.stringify(filter));
    let query = InboxMessage.find(filter);

    if (search) {
      query = query.find({
        $or: [
          { 'from.email': { $regex: search, $options: 'i' } },
          { 'from.name': { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
          { 'content.text': { $regex: search, $options: 'i' } }
        ]
      });
    }

    const messages = await query
      .sort({ receivedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .populate('emailAccountId', 'name email');

    console.log(`📬 Found ${messages.length} inbox messages`);
    const total = await InboxMessage.countDocuments(filter);
    const transformedMessages = messages.map(transformMessage);

    // Get email accounts for filtering
    const accounts = await EmailAccount.find({ userId: req.user._id, isActive: true })
      .select('name email');

    res.json({
      messages: transformedMessages,
      accounts: accounts.map(acc => ({
        id: acc._id.toString(),
        name: acc.name,
        email: acc.email
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching inbox messages:', error);
    res.status(500).json({ message: error.message });
  }
});

// Mark message as read/unread
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { isRead = true } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid message ID format' });
    }

    const message = await InboxMessage.findOneAndUpdate(
      { _id: id, userId: req.user._id },
      { isRead },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    res.json(transformMessage(message));
  } catch (error) {
    console.error('Error updating message read status:', error);
    res.status(400).json({ message: error.message });
  }
});

// Star/unstar message
router.patch('/:id/star', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { isStarred = true } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid message ID format' });
    }

    const message = await InboxMessage.findOneAndUpdate(
      { _id: id, userId: req.user._id },
      { isStarred },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    res.json(transformMessage(message));
  } catch (error) {
    console.error('Error updating message star status:', error);
    res.status(400).json({ message: error.message });
  }
});

// Update message labels
router.patch('/:id/labels', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { labels, action = 'set' } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid message ID format' });
    }

    if (!Array.isArray(labels)) {
      return res.status(400).json({ message: 'Labels must be an array' });
    }

    const message = await InboxMessage.findOne({ _id: id, userId: req.user._id });
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    let updatedLabels;
    switch (action) {
      case 'add':
        updatedLabels = [...new Set([...message.labels, ...labels])];
        break;
      case 'remove':
        updatedLabels = message.labels.filter(label => !labels.includes(label));
        break;
      case 'set':
      default:
        updatedLabels = labels;
        break;
    }

    message.labels = updatedLabels;
    await message.save();

    res.json(transformMessage(message));
  } catch (error) {
    console.error('Error updating message labels:', error);
    res.status(400).json({ message: error.message });
  }
});

// Delete message
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid message ID format' });
    }

    const message = await InboxMessage.findOneAndDelete({ _id: id, userId: req.user._id });

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ message: error.message });
  }
});

// Manually sync inbox
router.post('/sync/:accountId', authenticate, async (req, res) => {
  try {
    console.log('🔄 Manual inbox sync requested');
    const { accountId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID format' });
    }

    const account = await EmailAccount.findOne({ _id: accountId, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Email account not found' });
    }

    console.log('🔄 Manual inbox sync requested for account:', account.email, account._id);
    
    // Run inbox sync
    try {
      const result = await syncInbox(account);
      console.log('✅ Inbox sync completed:', result);
      
      res.json({
        message: 'Inbox sync completed successfully',
        result
      });
    } catch (syncError) {
      console.error('❌ Error during inbox sync:', syncError);
      res.status(500).json({ 
        message: 'Error syncing inbox', 
        error: syncError.message,
        stack: process.env.NODE_ENV !== 'production' ? syncError.stack : undefined
      });
    }
    
  } catch (error) {
    console.error('Error syncing inbox:', error);
    res.status(500).json({ message: error.message });
  }
});

// Send reply to a message
router.post('/reply', authenticate, async (req, res) => {
  try {
    const { to, subject, content, inReplyTo, threadId, accountId } = req.body;
    
    if (!to || !subject || !content || !accountId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({ message: 'Invalid account ID format' });
    }
    
    // Get the email account
    const account = await EmailAccount.findOne({ _id: accountId, userId: req.user._id });
    if (!account) {
      return res.status(404).json({ message: 'Email account not found' });
    }
    
    // Send the reply
    const emailData = {
      to,
      subject,
      content,
      type: 'reply',
      inReplyTo,
      threadId
    };
    
    const result = await sendEmail(account, emailData);
    
    if (!result.success) {
      return res.status(500).json({ message: 'Failed to send reply: ' + result.error });
    }
    
    res.json({ 
      message: 'Reply sent successfully',
      messageId: result.messageId
    });
  } catch (error) {
    console.error('Error sending reply:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get inbox stats
router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = {
      total: await InboxMessage.countDocuments({ userId: req.user._id }),
      unread: await InboxMessage.countDocuments({ userId: req.user._id, isRead: false }),
      starred: await InboxMessage.countDocuments({ userId: req.user._id, isStarred: true }),
      byAccount: []
    };

    // Get stats by account
    const accounts = await EmailAccount.find({ userId: req.user._id });
    for (const account of accounts) {
      const accountStats = {
        id: account._id.toString(),
        name: account.name,
        email: account.email,
        total: await InboxMessage.countDocuments({ userId: req.user._id, emailAccountId: account._id }),
        unread: await InboxMessage.countDocuments({ userId: req.user._id, emailAccountId: account._id, isRead: false })
      };
      stats.byAccount.push(accountStats);
    }

    res.json(stats);
  } catch (error) {
    console.error('Error fetching inbox stats:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;