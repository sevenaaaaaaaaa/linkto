// LinkToCore —— iOS 原生能力模块（v0.3.0 原生改造）
//
// 全部安全原语走平台原生实现，不再经过 JS 层软实现：
//  - sha256Hex  : CommonCrypto CC_SHA256
//  - randomB64  : SecRandomCopyBytes（密码学安全随机，替代 Math.random）
//  - pbkdf2Hex  : CCKeyDerivationPBKDF（PBKDF2-HMAC-SHA256，守卫验证器 KDF）
//  - haptic     : UIImpactFeedbackGenerator / UINotificationFeedbackGenerator

#import <React/RCTBridgeModule.h>
#import <CommonCrypto/CommonCrypto.h>
#import <CommonCrypto/CommonKeyDerivation.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <QuickLook/QuickLook.h>

static NSString *hexFromBytes(const uint8_t *bytes, size_t len) {
  NSMutableString *out = [NSMutableString stringWithCapacity:len * 2];
  for (size_t i = 0; i < len; i++) [out appendFormat:@"%02x", bytes[i]];
  return out;
}

@interface LinkToAttachmentPreview : QLPreviewController <QLPreviewControllerDataSource>
@property(nonatomic, strong) NSURL *attachmentURL;
@end
@implementation LinkToAttachmentPreview
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController *)controller { return 1; }
- (id<QLPreviewItem>)previewController:(QLPreviewController *)controller previewItemAtIndex:(NSInteger)index { return self.attachmentURL; }
@end

@interface LinkToCore : NSObject <RCTBridgeModule>
@end

@implementation LinkToCore

RCT_EXPORT_MODULE(LinkToCore)

RCT_EXPORT_METHOD(clearAttachments:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:@"linkto-attachments"];
  [[NSFileManager defaultManager] removeItemAtPath:directory error:nil];
  resolve(@YES);
}

RCT_EXPORT_METHOD(openAttachment:(NSString *)filename data:(NSString *)base64 type:(NSString *)mime share:(BOOL)share resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (!data || data.length > 15 * 1024 * 1024) { reject(@"ATTACHMENT_SIZE", @"附件无效或超过 15MB", nil); return; }
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:@"linkto-attachments"];
  NSFileManager *manager = [NSFileManager defaultManager];
  for (NSString *entry in [manager contentsOfDirectoryAtPath:root error:nil]) {
    NSString *path = [root stringByAppendingPathComponent:entry];
    NSDate *created = [manager attributesOfItemAtPath:path error:nil][NSFileCreationDate];
    if (created && -created.timeIntervalSinceNow > 86400) [manager removeItemAtPath:path error:nil];
  }
  NSString *directory = [root stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  [manager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionComplete} error:nil];
  NSString *name = filename.lastPathComponent.length ? filename.lastPathComponent : @"attachment.bin";
  NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:name]];
  NSError *error;
  if (![data writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionComplete error:&error]) { reject(@"ATTACHMENT_WRITE", @"附件暂存失败", error); return; }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindowScene *scene = nil;
    for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes) if (candidate.activationState == UISceneActivationStateForegroundActive && [candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
    UIViewController *presenter = scene.windows.firstObject.rootViewController;
    while (presenter.presentedViewController) presenter = presenter.presentedViewController;
    if (!presenter) { reject(@"ATTACHMENT_VIEW", @"请回到应用后重试", nil); return; }
    if (!share && [QLPreviewController canPreviewItem:url]) {
      LinkToAttachmentPreview *preview = [LinkToAttachmentPreview new]; preview.attachmentURL = url; preview.dataSource = preview;
      [presenter presentViewController:preview animated:YES completion:^{ resolve(@YES); }];
    } else {
      UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[url] applicationActivities:nil];
      sheet.popoverPresentationController.sourceView = presenter.view;
      sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(presenter.view.bounds), CGRectGetMidY(presenter.view.bounds), 1, 1);
      [presenter presentViewController:sheet animated:YES completion:^{ resolve(@YES); }];
    }
  });
}

RCT_EXPORT_METHOD(takeReminder:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *identifier = [[NSUserDefaults standardUserDefaults] stringForKey:@"linkto.pendingWorkItem"];
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"linkto.pendingWorkItem"];
  resolve(identifier ?: (id)[NSNull null]);
}

RCT_EXPORT_METHOD(scheduleReminder:(NSString *)identifier
                  title:(NSString *)title
                  at:(double)at
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                       completionHandler:^(BOOL granted, NSError *error) {
    if (error || !granted) {
      reject(@"REMINDER_PERMISSION", @"请在系统设置中允许 LinkTo 通知，内容已经保存", error);
      return;
    }
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    content.body = @"你安排的待办到时间了";
    content.sound = [UNNotificationSound defaultSound];
    content.userInfo = @{ @"workItemId": identifier };
    NSTimeInterval delay = MAX(1.0, at / 1000.0 - [[NSDate date] timeIntervalSince1970]);
    UNTimeIntervalNotificationTrigger *trigger = [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:delay repeats:NO];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[@"linkto-work-" stringByAppendingString:identifier] content:content trigger:trigger];
    [center addNotificationRequest:request withCompletionHandler:^(NSError *addError) {
      if (addError) reject(@"REMINDER_ERR", addError.localizedDescription, addError);
      else resolve(@YES);
    }];
  }];
}

RCT_EXPORT_METHOD(cancelReminder:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[UNUserNotificationCenter currentNotificationCenter] removePendingNotificationRequestsWithIdentifiers:@[[@"linkto-work-" stringByAppendingString:identifier]]];
  resolve(@YES);
}

RCT_EXPORT_METHOD(cancelAllReminders:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center removeAllPendingNotificationRequests];
  [center removeAllDeliveredNotifications];
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"linkto.pendingWorkItem"];
  resolve(@YES);
}

RCT_EXPORT_METHOD(sha256Hex:(NSString *)msg
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSData *data = [msg dataUsingEncoding:NSUTF8StringEncoding];
    uint8_t digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    resolve(hexFromBytes(digest, CC_SHA256_DIGEST_LENGTH));
  } @catch (NSException *e) {
    reject(@"SHA256_ERR", e.reason, nil);
  }
}

RCT_EXPORT_METHOD(randomB64:(NSInteger)len
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSInteger n = MIN(MAX(len, 16), 1024);
    uint8_t *bytes = (uint8_t *)malloc((size_t)n);
    if (!bytes) { reject(@"RANDOM_ERR", @"alloc failed", nil); return; }
    int rc = SecRandomCopyBytes(kSecRandomDefault, (size_t)n, bytes);
    if (rc != errSecSuccess) {
      free(bytes);
      reject(@"RANDOM_ERR", [NSString stringWithFormat:@"SecRandomCopyBytes rc=%d", rc], nil);
      return;
    }
    NSData *data = [NSData dataWithBytes:bytes length:(NSUInteger)n];
    free(bytes);
    resolve([data base64EncodedStringWithOptions:0]);
  } @catch (NSException *e) {
    reject(@"RANDOM_ERR", e.reason, nil);
  }
}

RCT_EXPORT_METHOD(pbkdf2Hex:(NSString *)password
                  salt:(NSString *)salt
                  iterations:(NSInteger)iterations
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSInteger iters = MIN(MAX(iterations, 10000), 1000000);
    NSData *pw = [password dataUsingEncoding:NSUTF8StringEncoding];
    NSData *sl = [salt dataUsingEncoding:NSUTF8StringEncoding];
    uint8_t key[32];
    int rc = CCKeyDerivationPBKDF(kCCPBKDF2, (const char *)pw.bytes, pw.length,
                                  (const uint8_t *)sl.bytes, sl.length,
                                  kCCPRFHmacAlgSHA256, (unsigned)iters, key, sizeof(key));
    if (rc != kCCSuccess) {
      reject(@"PBKDF2_ERR", [NSString stringWithFormat:@"CCKeyDerivationPBKDF rc=%d", rc], nil);
      return;
    }
    resolve(hexFromBytes(key, sizeof(key)));
  } @catch (NSException *e) {
    reject(@"PBKDF2_ERR", e.reason, nil);
  }
}

RCT_EXPORT_METHOD(haptic:(NSString *)kind
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if ([kind isEqualToString:@"heavy"]) {
      UIImpactFeedbackGenerator *g = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleHeavy];
      [g impactOccurred];
    } else if ([kind isEqualToString:@"warn"]) {
      UINotificationFeedbackGenerator *g = [[UINotificationFeedbackGenerator alloc] init];
      [g notificationOccurred:UINotificationFeedbackTypeWarning];
    } else {
      UIImpactFeedbackGenerator *g = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
      [g impactOccurred];
    }
    resolve(@(YES));
  });
}

@end
