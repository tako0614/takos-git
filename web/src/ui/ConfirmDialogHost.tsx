import { createUniqueId, type JSX } from "solid-js";
import {
  useConfirmDialogActions,
  useConfirmDialogState,
} from "../store/confirm.ts";
import { Dialog } from "./Dialog.tsx";
import { Button } from "./Button.tsx";

/**
 * Renders + resolves the confirm-dialog singleton. Mount once in AppShell; then
 * any view can `await useConfirmDialog().confirm({ title, message, danger })`.
 */
export function ConfirmDialogHost(): JSX.Element {
  const state = useConfirmDialogState();
  const { handleConfirm, handleCancel } = useConfirmDialogActions();
  const descId = createUniqueId();
  return (
    <Dialog
      open={state().isOpen}
      onClose={handleCancel}
      role="alertdialog"
      aria-describedby={descId}
      size="sm"
      title={state().title}
      footer={
        <>
          <Button
            variant="default"
            autofocus={state().danger ? true : undefined}
            onClick={handleCancel}
          >
            {state().cancelText ?? "Cancel"}
          </Button>
          <Button
            variant={state().danger ? "danger" : "primary"}
            onClick={handleConfirm}
          >
            {state().confirmText ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p id={descId} class="text-sm text-muted">{state().message}</p>
    </Dialog>
  );
}
