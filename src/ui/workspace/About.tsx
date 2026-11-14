import { useRef, useState } from "react";
import { Icon } from "../common/Icon";
import { lazyModule, useLazyModule } from "../common/lazy-module";
import { ModuleStatus } from "../common/ModuleStatus";

// The sources list is read when the dialog is first opened.
const aboutSources = lazyModule(() => import("./AboutSources"));

export function About() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const sources = useLazyModule(aboutSources, opened);

  return (
    <>
      <button
        className="about-button"
        type="button"
        aria-label="关于 Tamatamatori"
        aria-haspopup="dialog"
        aria-controls="about-dialog"
        title="版权、许可与数据来源"
        onClick={() => {
          setOpened(true);
          dialog.current?.showModal();
        }}
      >
        <Icon name="info" size={16} />
        About
      </button>
      <dialog
        id="about-dialog"
        className="about-dialog"
        aria-labelledby="about-title"
        aria-describedby="about-description"
        ref={dialog}
      >
        <header className="about-header">
          <div>
            <span className="eyebrow">ABOUT TAMATAMATORI</span>
            <h2 id="about-title">关于与版权</h2>
          </div>
          <button
            className="reset-button"
            type="button"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="about-body">
          <p id="about-description">
            Tamatamatori 是基于地理与天文数据的摄影构图模拟工具。以下汇集应用使用的数据、影像与开源软件来源。
          </p>
          {opened && (sources.module ? <sources.module.AboutSources /> : <ModuleStatus load={sources} name="来源列表" />)}
        </div>
      </dialog>
    </>
  );
}
