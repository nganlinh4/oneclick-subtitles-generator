const completedDocumentText = (result) => {
  if (result?.status !== 'complete'
      || typeof result.text !== 'string'
      || result.text.trim().length === 0) {
    return null;
  }
  return result.text;
};

const acknowledgeSavedDeliveries = async (deliveries) => {
  if (deliveries === undefined) return;
  if (!Array.isArray(deliveries)
      || deliveries.some((delivery) => typeof delivery?.acknowledge !== 'function')) {
    throw new TypeError('A completed document has invalid provider delivery ownership');
  }
  for (const delivery of deliveries) {
    await delivery.acknowledge();
  }
};

/**
 * The last guard before a generated document crosses the native save boundary. Partial and refused
 * generation outcomes are returned intact so their failed chunk IDs and delivery acknowledgements
 * remain available for retry; neither saving nor success notification is attempted.
 */
export const saveCompleteDocumentResult = async ({
  result,
  filename,
  save,
  notifySaved,
}) => {
  const text = completedDocumentText(result);
  if (text === null) return result;

  const saved = await save(text, filename);
  if (saved?.status === 'saved') {
    await acknowledgeSavedDeliveries(result.deliveries);
    notifySaved?.();
  }
  return { ...saved, documentResult: result };
};
