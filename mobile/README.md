# OnePhone для Android

Приложение создано из официального шаблона Solana Mobile `expo-web3js-wallet`. Выбран web3.js, потому что проверенный клиент OnePhone уже использует его. Android-экран импортирует общие `../src/sgt.ts` и `../src/eligibility.ts`: MWA подключает кошелёк, SGT читается из mainnet, программа OnePhone регистрирует допуск через `consume`.

## Запуск

Нужны Node.js 22, Android SDK, JDK 17+ и установленный на телефоне или эмуляторе кошелёк с Mobile Wallet Adapter. Проверка окружения: `npx solana-mobile@latest doctor`. Для MWA требуется **Android development build**; Expo Go не содержит нативный модуль кошелька. Настоящий SGT следует проверять на Seeker с публичным адресом его кошелька.

```powershell
cd mobile
npm ci
npx tsc --noEmit
npm run lint:check
npm run android
```

Для публикации кампании заполнить `.env.local` по `.env.example`: публичные адреса **развёрнутой** программы и Namespace PDA на mainnet. Текущий `../program-id.txt` служит только локальному validator: у нас нет ключа развёртывания для этого ID. До заполнения адресов приложение показывает SGT, но не предлагает транзакцию регистрации. Неправильная программа, PDA или содержимое Namespace приводят к отказу клиента. `EXPO_PUBLIC_*` доступны каждому пользователю APK; не помещать туда секреты и закрытый RPC-токен.

`consume` создаёт запись допуска, за которую кошелёк платит комиссию сети и rent. Он не платит вознаграждение. После закрытия окна организатор готовит `direct` preview Torque отдельной командой из корня OnePhone; повторное создание incentive может привести к новой выплате. Подробности — в `../docs/TORQUE-INTEGRATION.md`.

На текущей машине `npx tsc --noEmit`, `npm run lint:check`, `npx expo install --check`, Hermes Android export и `expo prebuild -p android --no-clean --no-install` прошли. `solana-mobile doctor` показал отсутствие JDK и Android SDK/adb, поэтому APK и работа MWA на телефоне здесь не проверены. В Windows sandbox исходный `expo prebuild` наткнулся на сбой `fs.cpSync`; нативная директория была вручную скопирована из скачанного официального Expo-шаблона и последующий `--no-clean` prebuild завершился успешно. Нативная директория `/android` генерируется и исключена из Git.
