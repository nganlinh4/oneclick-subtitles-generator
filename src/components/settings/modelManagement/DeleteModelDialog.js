import { useTranslation } from 'react-i18next';
import CustomModelDialog from '../CustomModelDialog';

/**
 * Component for confirming model deletion
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the dialog is open
 * @param {Function} props.onClose - Function to call when dialog is closed
 * @param {Object} props.model - Model to delete
 * @param {Function} props.onDelete - Function to call when delete button is clicked
 * @param {boolean} props.isDeleting - Whether a model is being deleted
 * @returns {JSX.Element} - Rendered component
 */
const DeleteModelDialog = ({ isOpen, onClose, model, onDelete, isDeleting }) => {
  const { t } = useTranslation();

  if (!model) return null;

  return (
    <CustomModelDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.modelManagement.confirmDelete')}
      footer={
        <>
          <button
            className="cancel-btn"
            onClick={onClose}
            disabled={isDeleting}
          >
            {t('common.cancel')}
          </button>
          <button
            className="delete-btn"
            onClick={onDelete}
            disabled={isDeleting}
          >
            {isDeleting && <span className="spinner"></span>}
            {isDeleting
              ? t('settings.modelManagement.deleting')
              : t('settings.modelManagement.delete')
            }
          </button>
        </>
      }
    >
      <p className="delete-confirmation-text">
        {t('settings.modelManagement.deleteConfirmationText', {
          modelName: model.name || ''
        })}
      </p>
    </CustomModelDialog>
  );
};

export default DeleteModelDialog;
