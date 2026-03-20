const MAX_BODY_CHARS = 260;

function compactBody(text) {
  if (!text) {
    return '';
  }

  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/g, '[link]')
    .trim();

  return cleaned.length > MAX_BODY_CHARS ? `${cleaned.slice(0, MAX_BODY_CHARS)}…` : cleaned;
}

function localSummary(contact, interactions, payments, workflows) {
  const mostRecentInteraction = interactions[0];
  const mostRecentPayment = payments[0];
  const openWorkflow = workflows.find((workflow) => workflow.status !== 'done') ?? workflows[0];
  const totalPaid = payments.reduce((total, payment) => total + Number(payment.amountCents || 0), 0);

  const lines = [
    `${contact.name} (${contact.email})${contact.company ? ` works at ${contact.company}` : ''}.`,
    interactions.length
      ? `Recent communication: ${interactions.length} interactions; latest subject "${mostRecentInteraction.subject ?? 'No subject'}".`
      : 'No interactions recorded yet.',
    payments.length
      ? `Payment history: ${payments.length} payments totaling ${(totalPaid / 100).toFixed(2)} ${mostRecentPayment.currency.toUpperCase()}.`
      : 'No payments recorded yet.',
    openWorkflow
      ? `Relationship status: ${openWorkflow.status}. Next action: ${openWorkflow.nextAction ?? 'none'}.`
      : 'No active workflow state.'
  ];

  return lines.join(' ');
}

async function anthropicSummary(config, contact, interactions, payments, workflows) {
  if (!config.anthropic_api_key) {
    return null;
  }

  const prompt = {
    contact: {
      name: contact.name,
      email: contact.email,
      company: contact.company,
      tags: contact.tags,
      aliases: contact.emailAliases
    },
    interactions: interactions.slice(0, 12).map((interaction) => ({
      at: interaction.createdAt,
      direction: interaction.direction,
      channel: interaction.channel,
      subject: interaction.subject,
      body: compactBody(interaction.body)
    })),
    payments: payments.slice(0, 12).map((payment) => ({
      at: payment.createdAt,
      amount_cents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      description: payment.description
    })),
    workflows: workflows.map((workflow) => ({
      status: workflow.status,
      waiting_on: workflow.waitingOn,
      next_action: workflow.nextAction,
      due_at: workflow.dueAt
    }))
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic_api_key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 220,
      messages: [
        {
          role: 'user',
          content:
            'Write a compact CRM memory summary in <=120 words. Include who they are, buying context, relationship status, and suggested next action. Data:\n' +
            JSON.stringify(prompt)
        }
      ]
    })
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const text = payload?.content?.[0]?.text?.trim();
  return text || null;
}

export async function generateSummary(config, contact, interactions, payments, workflows) {
  const generated = await anthropicSummary(config, contact, interactions, payments, workflows);
  if (generated) {
    return generated;
  }

  return localSummary(contact, interactions, payments, workflows);
}

export function compactInteraction(interaction) {
  return {
    at: interaction.createdAt,
    channel: interaction.channel,
    direction: interaction.direction,
    subject: interaction.subject,
    summary: compactBody(interaction.body)
  };
}
