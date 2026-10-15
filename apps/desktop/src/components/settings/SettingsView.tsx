import React, { useState } from "react";
import {
  Settings,
  ArrowLeft,
  Palette,
  KeyRound,
  SlidersHorizontal,
  Server,
  Globe,
  MessageSquare,
  Trash2,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ThemeId } from "../../theme.js";
import type { AppearanceController } from "../../use-appearance.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { CredentialsSettings } from "./CredentialsSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { GatewaySettings } from "./GatewaySettings.js";
import { MessagingSettings } from "./MessagingSettings.js";
import { RecycleSettings } from "./RecycleSettings.js";
import { SearchSettings } from "./SearchSettings.js";
import {
  SETTINGS_CATEGORIES,
  filterSettingsCategories,
  type SettingsCategoryId,
} from "./settings-categories.js";

const ICONS: Record<SettingsCategoryId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  credentials: KeyRound,
  provider: SlidersHorizontal,
  gateway: Server,
  search: Globe,
  messaging: MessageSquare,
  recycle: Trash2,
};

export function SettingsView(props: {
  refresh: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  themeSaved: boolean;
  appearance: AppearanceController;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<SettingsCategoryId>("general");
  const [visited, setVisited] = useState<SettingsCategoryId[]>(["general"]);
  const [query, setQuery] = useState("");
  const categories = filterSettingsCategories(query);
  const groups = [...new Set(categories.map((category) => category.group))];
  function select(id: SettingsCategoryId) {
    setSelected(id);
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
  }
  return (
    <div className="settings-layout">
      <aside className="settings-navigation" aria-label="设置分类">
        <div className="settings-navigation-heading">
          <h2>设置</h2>
          <button
            type="button"
            className="settings-back"
            onClick={props.onClose}
            title="返回工作台"
            aria-label="返回工作台"
          >
            <ArrowLeft size={18} aria-hidden="true" />
            <span>返回</span>
          </button>
        </div>
        <div className="settings-search">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索设置"
            placeholder="搜索设置"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
              if (event.key === "Enter" && categories[0])
                select(categories[0].id);
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <nav aria-label="设置导航">
          {groups.map((group) => (
            <section className="settings-nav-group" key={group}>
              <h3>{group}</h3>
              {categories
                .filter((category) => category.group === group)
                .map((category) => {
                  const Icon = ICONS[category.id];
                  return (
                    <button
                      type="button"
                      key={category.id}
                      aria-current={
                        selected === category.id ? "page" : undefined
                      }
                      aria-controls={
                        visited.includes(category.id)
                          ? `settings-${category.id}`
                          : undefined
                      }
                      onClick={() => select(category.id)}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span>{category.title}</span>
                    </button>
                  );
                })}
            </section>
          ))}
          {categories.length === 0 && (
            <p className="settings-empty" role="status">
              没有找到相关设置
            </p>
          )}
        </nav>
      </aside>
      {SETTINGS_CATEGORIES.filter((category) =>
        visited.includes(category.id),
      ).map((category) => (
        <section
          key={category.id}
          id={`settings-${category.id}`}
          className="settings-detail"
          hidden={selected !== category.id}
          aria-labelledby={`settings-title-${category.id}`}
          tabIndex={0}
        >
          <div className="settings-detail-inner">
            <header className="settings-page-heading">
              <h2 id={`settings-title-${category.id}`}>{category.title}</h2>
              <p>{category.description}</p>
            </header>
            {category.id === "general" && (
              <GeneralSettings refresh={props.refresh} />
            )}
            {category.id === "appearance" && (
              <AppearanceSettings
                theme={props.theme}
                onThemeChange={props.onThemeChange}
                themeSaved={props.themeSaved}
                appearance={props.appearance}
              />
            )}
            {category.id === "credentials" && (
              <CredentialsSettings active={selected === category.id} />
            )}
            {category.id === "provider" && <ProviderSettings refresh={props.refresh} />}
            {category.id === "gateway" && <GatewaySettings />}
            {category.id === "search" && (
              <SearchSettings active={selected === category.id} />
            )}
            {category.id === "messaging" && <MessagingSettings />}
            {category.id === "recycle" && (
              <RecycleSettings refreshHistory={props.refreshHistory} />
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
