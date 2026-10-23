// One editable list section of the transcription rules editor. `fields` names the object keys of
// a two-input row (term/definition style); without `fields` each item is a single string.
import { useTranslation } from 'react-i18next';

const RemoveIcon = () => (
  <span
    className="material-symbols-rounded"
    style={{ fontSize: 16, display: 'inline-block' }}
    aria-hidden="true"
  >
    close
  </span>
);

const RulesListSection = ({
  title,
  description,
  items,
  fields = null,
  placeholder = '',
  addLabel,
  onChangeItem,
  onRemoveItem,
  onAddItem,
  onInteract,
}) => {
  const { t } = useTranslation();
  const inputProps = (index, field, value) => ({
    value: value || '',
    onChange: (e) => onChangeItem(index, field, e.target.value),
    onClick: onInteract,
    onFocus: onInteract,
  });

  return (
    <div className="rules-editor-section">
      <h3>{title}</h3>
      <p className="section-description">{description}</p>

      {(items || []).map((item, index) => (
        <div key={index} className="array-item-row">
          {fields ? (
            <div className="term-inputs">
              <input
                {...inputProps(index, fields[0].name, item[fields[0].name])}
                placeholder={fields[0].placeholder}
              />
              <input
                {...inputProps(index, fields[1].name, item[fields[1].name])}
                placeholder={fields[1].placeholder}
                className="definition-input"
              />
            </div>
          ) : (
            <input
              {...inputProps(index, null, item)}
              placeholder={placeholder}
              className="full-width-input"
            />
          )}
          <button
            className="remove-item-button"
            onClick={() => onRemoveItem(index)}
            aria-label={t('rulesEditor.removeItem', 'Remove')}
          >
            <RemoveIcon />
          </button>
        </div>
      ))}

      <button
        className="add-item-button"
        onClick={onAddItem}
      >
        {addLabel}
      </button>
    </div>
  );
};

export default RulesListSection;
