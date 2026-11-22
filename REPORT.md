# FCMS end-to-end

41 of 41 checks pass; 195 of 195 screens clean.

## Checks

| | Area | Check | Detail |
|---|---|---|---|
| PASS | api | GET /health answers 200 | 200 |
| PASS | api | who am I, signed out: 401 | 401 |
| PASS | api | the books, signed out: 401 | 401 |
| PASS | api | the dashboard, signed out: 401 | 401 |
| PASS | api | wrong password: 401 INVALID_CREDENTIALS | 401 {"code":"INVALID_CREDENTIALS","message":"That employee number or password is not right.","detail":null,"traceId":"0HNQ8P |
| PASS | api | unknown employee: the same 401 (no enumeration) | 401 |
| PASS | api | an attendant has no sign-in | 401 |
| PASS | api | head office signs in | 200 |
| PASS | api | the token works: role HEAD_OFFICE | 200 HEAD_OFFICE |
| PASS | api | a tampered token is refused | 401 |
| PASS | api | a supervisor is refused the books (403) | 403 |
| PASS | api | sign-in is rate-limited: the 11th try from one address gets 429 | 401,401,401,401,401,401,401,401,401,401,429 |
| PASS | api | another address still signs in | 200 |
| PASS | browser | signed out, the dashboard sends you to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | a wrong password says so, and stays on sign-in | That employee number and password do not match. |
| PASS | browser | HO01 signs in and lands on / | / |
| PASS | browser | HO01's sidebar offers screens | 27: / /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /atten |
| PASS | browser | HO01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | SYSADMIN signs in and lands on / | / |
| PASS | browser | SYSADMIN's sidebar offers screens | 28: / /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /atten |
| PASS | browser | SYSADMIN signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | AUD01 signs in and lands on / | / |
| PASS | browser | AUD01's sidebar offers screens | 27: / /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /atten |
| PASS | browser | AUD01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | MGR01 signs in and lands on /site-operations-detail | /site-operations-detail |
| PASS | browser | MGR01's sidebar offers screens | 22: /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /attenda |
| PASS | browser | MGR01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | SUP01 signs in and lands on /site-operations-detail | /site-operations-detail |
| PASS | browser | SUP01's sidebar offers screens | 11: /site-operations-detail /shift-operations /inventory/tanks /other-stocks /stock-counts /pump-setup /pump-attendants /shift-closure /shift-closure/reports /c |
| PASS | browser | SUP01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | ACC01 signs in and lands on /site-operations-detail | /site-operations-detail |
| PASS | browser | ACC01's sidebar offers screens | 22: /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /attenda |
| PASS | browser | ACC01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | browser | DEP01 signs in and lands on /site-operations-detail | /site-operations-detail |
| PASS | browser | DEP01's sidebar offers screens | 22: /site-operations-detail /shift-operations /inventory/tanks /inventory/deliveries /other-stocks /products /stock-counts /pump-setup /pump-attendants /attenda |
| PASS | browser | DEP01 signs out, and the books then send to sign-in | http://localhost:3000/sign-up-login-screen |
| PASS | password | Set my password goes on to the home screen | /site-operations-detail  |
| PASS | password | after a change the old password is refused | 401 |
| PASS | password | and the new one signs in | 200 |
| PASS | password | the original password is put back afterwards | 200 |
| PASS | fields | every response has the fields its screen reads (141 contracts) |  |

## Fields a screen reads that the API does not send

None.

## Screens with issues

None.

## What the screens show (display review)

Nothing found.

## Refused by role (403), for information

- HO01: GET /api/admin/audit 403
- HO01: GET /api/v1/organisation/companies 403
- AUD01: GET /api/statements/expenses 403
- AUD01: GET /api/admin/policy 403
- AUD01: GET /api/admin/sessions 403
- SUP01: GET /api/credit/ageing 403
- SUP01: GET /api/depot/below-cost 403

## Every screen

| User | Screen | Result |
|---|---|---|
| HO01 | / | clean |
| HO01 | /site-operations-detail | clean |
| HO01 | /shift-operations | clean |
| HO01 | /inventory/tanks | clean |
| HO01 | /inventory/deliveries | clean |
| HO01 | /other-stocks | clean |
| HO01 | /products | clean |
| HO01 | /stock-counts | clean |
| HO01 | /stock-counts > Shop and lubricants | clean |
| HO01 | /stock-counts > Adjustments | clean |
| HO01 | /pump-setup | clean |
| HO01 | /pump-attendants | clean |
| HO01 | /attendant-shorts | clean |
| HO01 | /shift-closure | clean |
| HO01 | /shift-closure/reports | clean |
| HO01 | /shift-closure/reports > Gain / Loss | clean |
| HO01 | /shift-closure/reports > Sales & Payments | clean |
| HO01 | /shift-closure/reports > Variances | clean |
| HO01 | /shift-closure/reports > Statement | clean |
| HO01 | /expenses | clean |
| HO01 | /suppliers | clean |
| HO01 | /credit-customers | clean |
| HO01 | /credit-customers > Transactions | clean |
| HO01 | /payments | clean |
| HO01 | /payments > Provider Summary | clean |
| HO01 | /other-income | clean |
| HO01 | /depot | clean |
| HO01 | /books | clean |
| HO01 | /books > Bank & mobile money | clean |
| HO01 | /books > Receivables | clean |
| HO01 | /books > Profit & loss | clean |
| HO01 | /books > Journals | clean |
| HO01 | /books > Account ledger | clean |
| HO01 | /full-reports | clean |
| HO01 | /full-reports > Daily Statement | clean |
| HO01 | /full-reports > Weekly Summary | clean |
| HO01 | /full-reports > Monthly Report | clean |
| HO01 | /full-reports > Shift Reports | clean |
| HO01 | /full-reports > Gain / Loss | clean |
| HO01 | /full-reports > Stock Movement | clean |
| HO01 | /full-reports > Dipping Report | clean |
| HO01 | /full-reports > Expenses Report | clean |
| HO01 | /full-reports > Credit Statement | clean |
| HO01 | /full-reports > Payments Breakdown | clean |
| HO01 | /full-reports > Variances Report | clean |
| HO01 | /full-reports > Pump Performance | clean |
| HO01 | /losses | clean |
| HO01 | /losses > Meter divergence | clean |
| HO01 | /management-reports | clean |
| HO01 | /management-reports > Loss trend | clean |
| HO01 | /management-reports > Attendants | clean |
| HO01 | /management-reports > Stock card | clean |
| HO01 | /management-reports > Depot vs station | clean |
| HO01 | /management-reports > Duty periods | clean |
| HO01 | /management-reports > By shift | clean |
| HO01 | /reports | clean |
| HO01 | /users | clean |
| HO01 | /administration | clean |
| HO01 | /administration > Payment channels | clean |
| HO01 | /administration > Tank calibration | clean |
| HO01 | /administration > Depot | clean |
| HO01 | /system-customisation | clean |
| HO01 | /companies | clean |
| SYSADMIN | / | clean |
| SYSADMIN | /site-operations-detail | clean |
| SYSADMIN | /shift-operations | clean |
| SYSADMIN | /inventory/tanks | clean |
| SYSADMIN | /inventory/deliveries | clean |
| SYSADMIN | /other-stocks | clean |
| SYSADMIN | /products | clean |
| SYSADMIN | /stock-counts | clean |
| SYSADMIN | /pump-setup | clean |
| SYSADMIN | /pump-attendants | clean |
| SYSADMIN | /attendant-shorts | clean |
| SYSADMIN | /shift-closure | clean |
| SYSADMIN | /shift-closure/reports | clean |
| SYSADMIN | /expenses | clean |
| SYSADMIN | /suppliers | clean |
| SYSADMIN | /credit-customers | clean |
| SYSADMIN | /payments | clean |
| SYSADMIN | /other-income | clean |
| SYSADMIN | /depot | clean |
| SYSADMIN | /books | clean |
| SYSADMIN | /full-reports | clean |
| SYSADMIN | /losses | clean |
| SYSADMIN | /management-reports | clean |
| SYSADMIN | /reports | clean |
| SYSADMIN | /companies | clean |
| SYSADMIN | /users | clean |
| SYSADMIN | /administration | clean |
| SYSADMIN | /system-customisation | clean |
| AUD01 | / | clean |
| AUD01 | /site-operations-detail | clean |
| AUD01 | /shift-operations | clean |
| AUD01 | /inventory/tanks | clean |
| AUD01 | /inventory/deliveries | clean |
| AUD01 | /other-stocks | clean |
| AUD01 | /products | clean |
| AUD01 | /stock-counts | clean |
| AUD01 | /pump-setup | clean |
| AUD01 | /pump-attendants | clean |
| AUD01 | /attendant-shorts | clean |
| AUD01 | /shift-closure | clean |
| AUD01 | /shift-closure/reports | clean |
| AUD01 | /expenses | clean |
| AUD01 | /suppliers | clean |
| AUD01 | /credit-customers | clean |
| AUD01 | /payments | clean |
| AUD01 | /other-income | clean |
| AUD01 | /depot | clean |
| AUD01 | /books | clean |
| AUD01 | /full-reports | clean |
| AUD01 | /losses | clean |
| AUD01 | /management-reports | clean |
| AUD01 | /reports | clean |
| AUD01 | /users | clean |
| AUD01 | /administration | clean |
| AUD01 | /system-customisation | clean |
| MGR01 | /site-operations-detail | clean |
| MGR01 | /shift-operations | clean |
| MGR01 | /inventory/tanks | clean |
| MGR01 | /inventory/deliveries | clean |
| MGR01 | /other-stocks | clean |
| MGR01 | /products | clean |
| MGR01 | /stock-counts | clean |
| MGR01 | /pump-setup | clean |
| MGR01 | /pump-attendants | clean |
| MGR01 | /attendant-shorts | clean |
| MGR01 | /shift-closure | clean |
| MGR01 | /shift-closure/reports | clean |
| MGR01 | /expenses | clean |
| MGR01 | /suppliers | clean |
| MGR01 | /credit-customers | clean |
| MGR01 | /payments | clean |
| MGR01 | /other-income | clean |
| MGR01 | /depot | clean |
| MGR01 | /books | clean |
| MGR01 | /full-reports | clean |
| MGR01 | /losses | clean |
| MGR01 | /management-reports | clean |
| SUP01 | /site-operations-detail | clean |
| SUP01 | /shift-operations | clean |
| SUP01 | /inventory/tanks | clean |
| SUP01 | /other-stocks | clean |
| SUP01 | /stock-counts | clean |
| SUP01 | /pump-setup | clean |
| SUP01 | /pump-attendants | clean |
| SUP01 | /shift-closure | clean |
| SUP01 | /shift-closure/reports | clean |
| SUP01 | /credit-customers | clean |
| SUP01 | /depot | clean |
| ACC01 | /site-operations-detail | clean |
| ACC01 | /shift-operations | clean |
| ACC01 | /inventory/tanks | clean |
| ACC01 | /inventory/deliveries | clean |
| ACC01 | /other-stocks | clean |
| ACC01 | /products | clean |
| ACC01 | /stock-counts | clean |
| ACC01 | /pump-setup | clean |
| ACC01 | /pump-attendants | clean |
| ACC01 | /attendant-shorts | clean |
| ACC01 | /shift-closure | clean |
| ACC01 | /shift-closure/reports | clean |
| ACC01 | /expenses | clean |
| ACC01 | /suppliers | clean |
| ACC01 | /credit-customers | clean |
| ACC01 | /payments | clean |
| ACC01 | /other-income | clean |
| ACC01 | /depot | clean |
| ACC01 | /books | clean |
| ACC01 | /full-reports | clean |
| ACC01 | /losses | clean |
| ACC01 | /management-reports | clean |
| DEP01 | /site-operations-detail | clean |
| DEP01 | /shift-operations | clean |
| DEP01 | /inventory/tanks | clean |
| DEP01 | /inventory/deliveries | clean |
| DEP01 | /other-stocks | clean |
| DEP01 | /products | clean |
| DEP01 | /stock-counts | clean |
| DEP01 | /pump-setup | clean |
| DEP01 | /pump-attendants | clean |
| DEP01 | /attendant-shorts | clean |
| DEP01 | /shift-closure | clean |
| DEP01 | /shift-closure/reports | clean |
| DEP01 | /expenses | clean |
| DEP01 | /suppliers | clean |
| DEP01 | /credit-customers | clean |
| DEP01 | /payments | clean |
| DEP01 | /other-income | clean |
| DEP01 | /depot | clean |
| DEP01 | /books | clean |
| DEP01 | /full-reports | clean |
| DEP01 | /losses | clean |
| DEP01 | /management-reports | clean |