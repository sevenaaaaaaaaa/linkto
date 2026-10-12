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

static NSString *hexFromBytes(const uint8_t *bytes, size_t len) {
  NSMutableString *out = [NSMutableString stringWithCapacity:len * 2];
  for (size_t i = 0; i < len; i++) [out appendFormat:@"%02x", bytes[i]];
  return out;
}

@interface LinkToCore : NSObject <RCTBridgeModule>
@end

@implementation LinkToCore

RCT_EXPORT_MODULE(LinkToCore)

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