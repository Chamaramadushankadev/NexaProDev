import cron from 'node-cron';
import { EmailAccount, Campaign, Lead, WarmupEmail } from '../models/ColdEmailSystem.js';
import { sendEmail, generateWarmupContent } from './emailService.js';

// Schedule warmup emails
export const scheduleWarmupEmails = async (account) => {
  try {
    if (!account.warmupSettings.enabled) return;

    const otherAccounts = await EmailAccount.find({
      userId: account.userId,
      _id: { $ne: account._id },
      isActive: true
    });

    if (otherAccounts.length === 0) {
      console.log('No other accounts available for warmup');
      return;
    }

    const dailyWarmupEmails = account.warmupSettings.dailyWarmupEmails;
    const emailsPerAccount = Math.ceil(dailyWarmupEmails / otherAccounts.length);

    for (let i = 0; i < emailsPerAccount; i++) {
      const targetAccount = otherAccounts[i % otherAccounts.length];
      const { subject, content } = generateWarmupContent();

      // Schedule email with random delay (1-5 minutes)
      const delay = Math.floor(Math.random() * 5 * 60 * 1000) + 60 * 1000;
      
      setTimeout(async () => {
        try {
          const emailData = {
            to: targetAccount.email,
            subject,
            content,
            type: 'warmup'
          };

          const result = await sendEmail(account, emailData);
          
          if (result.success) {
            // Create warmup email record
            const warmupEmail = new WarmupEmail({
              userId: account.userId,
              fromAccountId: account._id,
              toAccountId: targetAccount._id,
              subject,
              content,
              sentAt: new Date(),
              status: 'sent'
            });
            await warmupEmail.save();

            console.log(`Warmup email sent from ${account.email} to ${targetAccount.email}`);
          }
        } catch (error) {
          console.error('Error sending warmup email:', error);
        }
      }, delay);
    }
  } catch (error) {
    console.error('Error scheduling warmup emails:', error);
  }
};

// Schedule campaign emails
export const scheduleCampaignEmails = async (campaign) => {
  try {
    if (campaign.status !== 'active') return;

    const leads = await Lead.find({
      _id: { $in: campaign.leadIds },
      status: { $nin: ['unsubscribed', 'bounced'] }
    });

    const emailAccounts = await EmailAccount.find({
      _id: { $in: campaign.emailAccountIds },
      isActive: true
    });

    if (emailAccounts.length === 0) {
      console.log('No active email accounts available for campaign');
      return;
    }

    let accountIndex = 0;
    let emailsSentToday = 0;

    for (const lead of leads) {
      const account = emailAccounts[accountIndex % emailAccounts.length];
      
      // Check daily limit
      if (account.emailsSentToday >= account.dailyLimit) {
        accountIndex++;
        continue;
      }

      // Get the first step of the sequence
      const firstStep = campaign.sequence.find(step => step.stepNumber === 1 && step.isActive);
      if (!firstStep) continue;

      // Replace variables in subject and content
      const subject = replaceVariables(firstStep.subject, lead);
      const content = replaceVariables(firstStep.content, lead);

      // Calculate delay based on throttling settings
      const baseDelay = campaign.settings.throttling.delayBetweenEmails * 1000;
      const randomDelay = campaign.settings.throttling.randomizeDelay 
        ? Math.floor(Math.random() * baseDelay * 0.5) 
        : 0;
      const totalDelay = baseDelay + randomDelay + (emailsSentToday * baseDelay);

      // Schedule the email
      setTimeout(async () => {
        try {
          const emailData = {
            to: lead.email,
            subject,
            content,
            type: 'campaign',
            campaignId: campaign._id,
            leadId: lead._id,
            stepNumber: firstStep.stepNumber,
            trackingEnabled: campaign.settings.tracking.openTracking
          };

          const result = await sendEmail(account, emailData);
          
          if (result.success) {
            // Update lead status
            lead.status = 'contacted';
            lead.lastContactedAt = new Date();
            await lead.save();

            // Update campaign stats
            campaign.stats.emailsSent += 1;
            await campaign.save();

            console.log(`Campaign email sent to ${lead.email} from ${account.email}`);
          }
        } catch (error) {
          console.error('Error sending campaign email:', error);
        }
      }, totalDelay);

      emailsSentToday++;
      accountIndex++;
    }
  } catch (error) {
    console.error('Error scheduling campaign emails:', error);
  }
};

// Replace variables in email content
const replaceVariables = (text, lead) => {
  return text
    .replace(/\{\{first_name\}\}/g, lead.firstName)
    .replace(/\{\{last_name\}\}/g, lead.lastName)
    .replace(/\{\{company\}\}/g, lead.company || '')
    .replace(/\{\{job_title\}\}/g, lead.jobTitle || '')
    .replace(/\{\{website\}\}/g, lead.website || '')
    .replace(/\{\{industry\}\}/g, lead.industry || '');
};

// Start background jobs
export const startBackgroundJobs = () => {
  // Run warmup emails every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const accounts = await EmailAccount.find({
        warmupStatus: 'in-progress',
        isActive: true,
        'warmupSettings.enabled': true
      });

      for (const account of accounts) {
        await scheduleWarmupEmails(account);
      }
    } catch (error) {
      console.error('Error in warmup cron job:', error);
    }
  });

  // Run inbox sync every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { syncInbox } = await import('./emailService.js');
      const accounts = await EmailAccount.find({ isActive: true });

      for (const account of accounts) {
        try {
          await syncInbox(account);
        } catch (error) {
          console.error(`Error syncing inbox for ${account.email}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in inbox sync cron job:', error);
    }
  });

  // Reset daily email counts at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await EmailAccount.updateMany(
        {},
        { 
          emailsSentToday: 0,
          lastResetDate: new Date()
        }
      );
      console.log('Daily email counts reset');
    } catch (error) {
      console.error('Error resetting daily email counts:', error);
    }
  });

  console.log('Background jobs started');
};