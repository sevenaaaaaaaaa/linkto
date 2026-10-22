#import <AppKit/AppKit.h>
#import <node_api.h>

/**
 * LinkTo 原生混合壳（macOS）：
 *  - 在 Electron BrowserWindow 的 NSWindow 上挂一个真正的 NSToolbar（unified 标题栏）
 *  - 工具项：账户标题 / NSSearchField / 写邮件 / 幽灵信 / 设置
 *  - 动作通过 N-API 回调交给主进程，再转成渲染层事件
 *  - Web 内容仍然铺满 contentView（fullSizeContentView），由前端留出 52px 顶部内边距
 *
 * 注意：不替换 Electron 的 contentViewController（会把 web view 从窗口层级里拿走）；
 * 这里用一个 NSObject 作为 NSToolbarDelegate / 原生壳控制器。
 */

static const NSToolbarItemIdentifier kTitleItem = @"com.linkto.toolbar.title";
static const NSToolbarItemIdentifier kSearchItem = @"com.linkto.toolbar.search";
static const NSToolbarItemIdentifier kAISearchItem = @"com.linkto.toolbar.ai-search";
static const NSToolbarItemIdentifier kComposeItem = @"com.linkto.toolbar.compose";
static const NSToolbarItemIdentifier kGhostItem = @"com.linkto.toolbar.ghost";
static const NSToolbarItemIdentifier kSettingsItem = @"com.linkto.toolbar.settings";

@interface LinkToToolbarHost : NSObject <NSToolbarDelegate, NSSearchFieldDelegate>
@property (nonatomic, weak) NSWindow *window;
@property (nonatomic, strong) NSToolbar *toolbar;
@property (nonatomic, strong) NSTextField *titleField;
@property (nonatomic, strong) NSSearchField *searchField;
@property (nonatomic, copy) NSString *pendingTitle;
@property (nonatomic, copy) NSString *pendingSearch;
@property (nonatomic) napi_env env;
@property (nonatomic) napi_ref callback;
@end

static LinkToToolbarHost *gHost = nil;

@implementation LinkToToolbarHost

- (void)dealloc {
  if (self.callback && self.env) {
    napi_delete_reference(self.env, self.callback);
    self.callback = nullptr;
  }
}

- (void)emit:(NSString *)action query:(NSString *)query {
  napi_env env = self.env;
  napi_ref ref = self.callback;
  if (!env || !ref) return;
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value global = nullptr;
  napi_value fn = nullptr;
  napi_value arg = nullptr;
  napi_value result = nullptr;
  napi_get_global(env, &global);
  if (napi_get_reference_value(env, ref, &fn) == napi_ok && fn) {
    napi_create_object(env, &arg);
    napi_value v = nullptr;
    napi_create_string_utf8(env, action.UTF8String, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, arg, "action", v);
    if (query) {
      napi_create_string_utf8(env, query.UTF8String, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, arg, "query", v);
    }
    napi_call_function(env, global, fn, 1, &arg, &result);
  }
  napi_close_handle_scope(env, scope);
}

- (NSToolbarItem *)makeButtonItem:(NSToolbarItemIdentifier)identifier symbol:(NSString *)symbol label:(NSString *)label action:(SEL)action {
  NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
  NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:label];
  NSButton *button = [NSButton buttonWithImage:image target:self action:action];
  button.bezelStyle = NSBezelStyleTexturedRounded;
  button.imagePosition = NSImageOnly;
  button.frame = NSMakeRect(0, 0, 34, 28);
  button.toolTip = label;
  item.view = button;
  item.label = label;
  item.paletteLabel = label;
  item.toolTip = label;
  item.minSize = NSMakeSize(34, 28);
  item.maxSize = NSMakeSize(34, 28);
  return item;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
  return @[ kTitleItem, kSearchItem, kAISearchItem, NSToolbarFlexibleSpaceItemIdentifier, kComposeItem, kGhostItem, kSettingsItem ];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
  return @[ kTitleItem, kSearchItem, kAISearchItem, NSToolbarFlexibleSpaceItemIdentifier, kComposeItem, kGhostItem, kSettingsItem ];
}

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar itemForItemIdentifier:(NSToolbarItemIdentifier)identifier willBeInsertedIntoToolbar:(BOOL)flag {
  if ([identifier isEqualToString:kTitleItem]) {
    NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
    self.titleField = [NSTextField labelWithString:@"LinkTo"];
    self.titleField.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    self.titleField.textColor = NSColor.labelColor;
    self.titleField.lineBreakMode = NSLineBreakByTruncatingTail;
    self.titleField.frame = NSMakeRect(0, 0, 180, 22);
    if (self.pendingTitle.length) self.titleField.stringValue = self.pendingTitle;
    item.view = self.titleField;
    item.label = @"LinkTo";
    item.paletteLabel = @"LinkTo";
    item.minSize = NSMakeSize(120, 22);
    item.maxSize = NSMakeSize(280, 22);
    return item;
  }
  if ([identifier isEqualToString:kSearchItem]) {
    NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
    self.searchField = [[NSSearchField alloc] initWithFrame:NSMakeRect(0, 0, 280, 28)];
    self.searchField.placeholderString = @"搜索邮件（支持 from: 等语法）";
    self.searchField.delegate = self;
    self.searchField.sendsWholeSearchString = NO;
    self.searchField.sendsSearchStringImmediately = YES;
    self.searchField.focusRingType = NSFocusRingTypeExterior;
    if (self.pendingSearch.length) self.searchField.stringValue = self.pendingSearch;
    item.view = self.searchField;
    item.label = @"搜索邮件";
    item.paletteLabel = @"搜索邮件";
    item.minSize = NSMakeSize(220, 28);
    item.maxSize = NSMakeSize(420, 28);
    return item;
  }
  if ([identifier isEqualToString:kAISearchItem]) {
    return [self makeButtonItem:identifier symbol:@"sparkles" label:@"AI 搜索" action:@selector(aiSearchAction:)];
  }
  if ([identifier isEqualToString:kComposeItem]) {
    return [self makeButtonItem:identifier symbol:@"square.and.pencil" label:@"写邮件" action:@selector(composeAction:)];
  }
  if ([identifier isEqualToString:kGhostItem]) {
    return [self makeButtonItem:identifier symbol:@"envelope.badge.shield.half.filled" label:@"幽灵信" action:@selector(ghostAction:)];
  }
  if ([identifier isEqualToString:kSettingsItem]) {
    return [self makeButtonItem:identifier symbol:@"gearshape" label:@"设置" action:@selector(settingsAction:)];
  }
  return nil;
}

- (void)aiSearchAction:(id)sender { [self emit:@"search-ai" query:self.searchField.stringValue]; }
- (void)composeAction:(id)sender { [self emit:@"compose" query:nil]; }
- (void)ghostAction:(id)sender { [self emit:@"ghost" query:nil]; }
- (void)settingsAction:(id)sender { [self emit:@"settings" query:nil]; }

- (void)controlTextDidChange:(NSNotification *)notification {
  if (notification.object == self.searchField) [self emit:@"search" query:self.searchField.stringValue];
}

- (void)setTitle:(NSString *)title {
  if (!title.length) return;
  self.pendingTitle = title;
  if (self.titleField) self.titleField.stringValue = title;
}

- (void)setSearchText:(NSString *)text {
  NSString *next = text ?: @"";
  self.pendingSearch = next;
  if (self.searchField && ![self.searchField.stringValue isEqualToString:next]) self.searchField.stringValue = next;
}

- (void)focusSearch {
  [self.window makeFirstResponder:self.searchField];
  [self.searchField selectText:nil];
}
@end

static NSWindow *WindowFromHandle(napi_env env, napi_value value) {
  void *data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, value, &data, &len) != napi_ok || !data || len < sizeof(void *)) return nil;
  id obj = (__bridge id)(*(void **)data);
  if ([obj isKindOfClass:[NSWindow class]]) return (NSWindow *)obj;
  if ([obj isKindOfClass:[NSView class]]) return [(NSView *)obj window];
  return nil;
}

static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result = nullptr;
  napi_get_boolean(env, false, &result);
  if (argc < 2) return result;
  NSWindow *window = WindowFromHandle(env, argv[0]);
  napi_valuetype type = napi_undefined;
  napi_typeof(env, argv[1], &type);
  if (!window || type != napi_function) return result;

  if (gHost) {
    gHost.window = nil;
    gHost = nil;
  }
  LinkToToolbarHost *host = [LinkToToolbarHost new];
  host.window = window;
  host.env = env;
  napi_ref callbackRef = nullptr;
  if (napi_create_reference(env, argv[1], 1, &callbackRef) != napi_ok) return result;
  host.callback = callbackRef;

  NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"com.linkto.main.toolbar"];
  toolbar.delegate = host;
  toolbar.displayMode = NSToolbarDisplayModeIconOnly;
  toolbar.sizeMode = NSToolbarSizeModeRegular;
  toolbar.allowsUserCustomization = NO;
  toolbar.autosavesConfiguration = NO;
  toolbar.showsBaselineSeparator = NO;
  host.toolbar = toolbar;

  window.toolbar = toolbar;
  if (@available(macOS 11.0, *)) window.toolbarStyle = NSWindowToolbarStyleUnified;
  window.titleVisibility = NSWindowTitleHidden;
  window.titlebarAppearsTransparent = YES;
  window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  toolbar.visible = YES;

  gHost = host;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value SetTitle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || !gHost) return nullptr;
  size_t len = 0;
  napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
  char *buf = (char *)malloc(len + 1);
  napi_get_value_string_utf8(env, argv[0], buf, len + 1, &len);
  [gHost setTitle:[NSString stringWithUTF8String:buf]];
  free(buf);
  return nullptr;
}

static napi_value SetSearch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || !gHost) return nullptr;
  size_t len = 0;
  napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
  char *buf = (char *)malloc(len + 1);
  napi_get_value_string_utf8(env, argv[0], buf, len + 1, &len);
  [gHost setSearchText:[NSString stringWithUTF8String:buf]];
  free(buf);
  return nullptr;
}

static napi_value FocusSearch(napi_env env, napi_callback_info info) {
  if (gHost) [gHost focusSearch];
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    { "attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setTitle", nullptr, SetTitle, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setSearch", nullptr, SetSearch, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "focusSearch", nullptr, FocusSearch, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
